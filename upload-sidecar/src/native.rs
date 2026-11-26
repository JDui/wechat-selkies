use std::{
    collections::VecDeque,
    ffi::{CString, c_char, c_int, c_uint, c_ulong, c_void},
    ptr,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

#[repr(C)]
pub struct AudioQueue {
    capacity: usize,
    chunks: Mutex<VecDeque<Vec<u8>>>,
    dropped: AtomicU64,
}

#[unsafe(no_mangle)]
pub extern "C" fn selkies_audio_queue_new(capacity: usize) -> *mut AudioQueue {
    if !(1..=256).contains(&capacity) {
        return ptr::null_mut();
    }
    Box::into_raw(Box::new(AudioQueue {
        capacity,
        chunks: Mutex::new(VecDeque::with_capacity(capacity)),
        dropped: AtomicU64::new(0),
    }))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn selkies_audio_queue_push(
    queue: *mut AudioQueue,
    data: *const u8,
    length: usize,
) -> c_int {
    if queue.is_null() || data.is_null() || length == 0 || length > 64 * 1024 {
        return -1;
    }
    let queue = unsafe { &*queue };
    let source = unsafe { std::slice::from_raw_parts(data, length) };
    let mut chunks = match queue.chunks.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let dropped = if chunks.len() >= queue.capacity {
        chunks.pop_front();
        queue.dropped.fetch_add(1, Ordering::Relaxed);
        1
    } else {
        0
    };
    chunks.push_back(source.to_vec());
    dropped
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn selkies_audio_queue_pop(
    queue: *mut AudioQueue,
    output: *mut u8,
    capacity: usize,
    output_length: *mut usize,
) -> c_int {
    if queue.is_null() || output.is_null() || output_length.is_null() {
        return -1;
    }
    let queue = unsafe { &*queue };
    let mut chunks = match queue.chunks.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let Some(chunk) = chunks.pop_front() else {
        unsafe { *output_length = 0 };
        return 0;
    };
    if chunk.len() > capacity {
        chunks.push_front(chunk);
        return -2;
    }
    unsafe {
        ptr::copy_nonoverlapping(chunk.as_ptr(), output, chunk.len());
        *output_length = chunk.len();
    }
    1
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn selkies_audio_queue_len(queue: *mut AudioQueue) -> usize {
    if queue.is_null() {
        return 0;
    }
    let queue = unsafe { &*queue };
    match queue.chunks.lock() {
        Ok(guard) => guard.len(),
        Err(poisoned) => poisoned.into_inner().len(),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn selkies_audio_queue_dropped(queue: *mut AudioQueue) -> u64 {
    if queue.is_null() {
        return 0;
    }
    unsafe { (&*queue).dropped.load(Ordering::Relaxed) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn selkies_audio_queue_free(queue: *mut AudioQueue) {
    if !queue.is_null() {
        drop(unsafe { Box::from_raw(queue) });
    }
}

#[link(name = "dl")]
unsafe extern "C" {
    fn dlopen(filename: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn dlclose(handle: *mut c_void) -> c_int;
}

type XOpenDisplay = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type XCloseDisplay = unsafe extern "C" fn(*mut c_void) -> c_int;
type XSync = unsafe extern "C" fn(*mut c_void, c_int) -> c_int;
type XTestFakeKeyEvent = unsafe extern "C" fn(*mut c_void, c_uint, c_int, c_ulong) -> c_int;

pub struct XTestHandle {
    display: *mut c_void,
    x11: *mut c_void,
    xtst: *mut c_void,
    close_display: XCloseDisplay,
    sync: XSync,
    fake_key_event: XTestFakeKeyEvent,
    lock: Mutex<()>,
}

unsafe impl Send for XTestHandle {}
unsafe impl Sync for XTestHandle {}

unsafe fn load_symbol<T: Copy>(handle: *mut c_void, name: &'static [u8]) -> Result<T, ()> {
    let symbol = unsafe { dlsym(handle, name.as_ptr().cast()) };
    if symbol.is_null() {
        return Err(());
    }
    Ok(unsafe { std::mem::transmute_copy(&symbol) })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn selkies_xtest_open(display_name: *const c_char) -> *mut XTestHandle {
    let x11_name = CString::new("libX11.so.6").unwrap();
    let xtst_name = CString::new("libXtst.so.6").unwrap();
    let x11 = unsafe { dlopen(x11_name.as_ptr(), 2) };
    if x11.is_null() {
        return ptr::null_mut();
    }
    let xtst = unsafe { dlopen(xtst_name.as_ptr(), 2) };
    if xtst.is_null() {
        unsafe { dlclose(x11) };
        return ptr::null_mut();
    }

    let open_display = match unsafe { load_symbol::<XOpenDisplay>(x11, b"XOpenDisplay\0") } {
        Ok(value) => value,
        Err(_) => {
            unsafe { dlclose(xtst); dlclose(x11); }
            return ptr::null_mut();
        }
    };
    let close_display = match unsafe { load_symbol::<XCloseDisplay>(x11, b"XCloseDisplay\0") } {
        Ok(value) => value,
        Err(_) => {
            unsafe { dlclose(xtst); dlclose(x11); }
            return ptr::null_mut();
        }
    };
    let sync = match unsafe { load_symbol::<XSync>(x11, b"XSync\0") } {
        Ok(value) => value,
        Err(_) => {
            unsafe { dlclose(xtst); dlclose(x11); }
            return ptr::null_mut();
        }
    };
    let fake_key_event = match unsafe { load_symbol::<XTestFakeKeyEvent>(xtst, b"XTestFakeKeyEvent\0") } {
        Ok(value) => value,
        Err(_) => {
            unsafe { dlclose(xtst); dlclose(x11); }
            return ptr::null_mut();
        }
    };

    let display = unsafe { open_display(display_name) };
    if display.is_null() {
        unsafe { dlclose(xtst); dlclose(x11); }
        return ptr::null_mut();
    }
    Box::into_raw(Box::new(XTestHandle {
        display,
        x11,
        xtst,
        close_display,
        sync,
        fake_key_event,
        lock: Mutex::new(()),
    }))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn selkies_xtest_key(
    handle: *mut XTestHandle,
    keycode: c_uint,
    pressed: c_int,
) -> c_int {
    if handle.is_null() || keycode == 0 {
        return -1;
    }
    let handle = unsafe { &*handle };
    let _guard = match handle.lock.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let accepted = unsafe {
        (handle.fake_key_event)(handle.display, keycode, if pressed != 0 { 1 } else { 0 }, 0)
    };
    unsafe { (handle.sync)(handle.display, 0) };
    if accepted != 0 { 0 } else { -2 }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn selkies_xtest_close(handle: *mut XTestHandle) {
    if handle.is_null() {
        return;
    }
    let handle = unsafe { Box::from_raw(handle) };
    unsafe {
        (handle.close_display)(handle.display);
        dlclose(handle.xtst);
        dlclose(handle.x11);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_queue_drops_oldest_and_keeps_latest() {
        let queue = selkies_audio_queue_new(2);
        assert!(!queue.is_null());
        let first = b"first";
        let second = b"second";
        let third = b"third";
        unsafe {
            assert_eq!(selkies_audio_queue_push(queue, first.as_ptr(), first.len()), 0);
            assert_eq!(selkies_audio_queue_push(queue, second.as_ptr(), second.len()), 0);
            assert_eq!(selkies_audio_queue_push(queue, third.as_ptr(), third.len()), 1);
            assert_eq!(selkies_audio_queue_len(queue), 2);
            assert_eq!(selkies_audio_queue_dropped(queue), 1);
            let mut output = [0_u8; 64];
            let mut length = 0_usize;
            assert_eq!(selkies_audio_queue_pop(queue, output.as_mut_ptr(), output.len(), &mut length), 1);
            assert_eq!(&output[..length], second);
            assert_eq!(selkies_audio_queue_pop(queue, output.as_mut_ptr(), output.len(), &mut length), 1);
            assert_eq!(&output[..length], third);
            assert_eq!(selkies_audio_queue_pop(queue, output.as_mut_ptr(), output.len(), &mut length), 0);
            selkies_audio_queue_free(queue);
        }
    }

    #[test]
    fn audio_queue_rejects_invalid_capacity_and_oversized_chunk() {
        assert!(selkies_audio_queue_new(0).is_null());
        let queue = selkies_audio_queue_new(1);
        let data = vec![0_u8; 64 * 1024 + 1];
        unsafe {
            assert_eq!(selkies_audio_queue_push(queue, data.as_ptr(), data.len()), -1);
            selkies_audio_queue_free(queue);
        }
    }
}
