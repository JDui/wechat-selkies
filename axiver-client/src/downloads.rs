//! Native downloads retain their original browser request and session while
//! waiting for explicit confirmation. Only the trusted UI can choose/reveal files.
use crate::protocol::{MAIN_LABEL, SHELL_LABEL};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};
use tauri::Manager;

#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub enum DownloadMode {
    #[default]
    #[serde(rename = "default")]
    DefaultLocation,
    #[serde(rename = "ask")]
    AskEachTime,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DownloadSettings {
    pub mode: DownloadMode,
    pub directory: Option<PathBuf>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRecord {
    pub id: u64,
    pub name: String,
    pub status: String,
    pub path: Option<PathBuf>,
    pub received: u64,
    pub total: Option<u64>,
    pub speed_bps: f64,
    pub error: Option<String>,
    pub mode: DownloadMode,
    pub directory: Option<PathBuf>,
    #[serde(skip)]
    updated: Instant,
    #[serde(skip)]
    rate: TransferRate,
}

// A one-second sliding window excludes time spent awaiting confirmation.
#[derive(Clone, Default)]
struct TransferRate(VecDeque<(Instant, u64)>);
impl TransferRate {
    fn reset(&mut self, now: Instant, received: u64) {
        self.0.clear();
        self.0.push_back((now, received));
    }
    fn sample(&mut self, now: Instant, received: u64) -> f64 {
        self.0.push_back((now, received));
        while self.0.len() > 2 && now.duration_since(self.0[1].0).as_secs_f64() >= 1.0 {
            self.0.pop_front();
        }
        let (start, bytes) = self.0.front().copied().unwrap();
        let elapsed = now.duration_since(start).as_secs_f64();
        if elapsed < 0.1 {
            0.0
        } else {
            received.saturating_sub(bytes) as f64 / elapsed
        }
    }
}

pub struct DownloadManager {
    app: tauri::AppHandle,
    next_id: AtomicU64,
    records: Mutex<Vec<DownloadRecord>>,
    last_directory: Mutex<Option<PathBuf>>,
    settings: Mutex<DownloadSettings>,
    settings_path: PathBuf,
    dialog_gate: tauri::async_runtime::Mutex<()>,
    reservation_gate: tauri::async_runtime::Mutex<()>,
    persistence_gate: Mutex<()>,
    publish_revision: Arc<AtomicU64>,
}

impl DownloadManager {
    pub fn start_progress_clock(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(250));
                let Some(manager) = weak.upgrade() else { break };
                let mut active = false;
                {
                    let mut records = manager.records.lock().unwrap();
                    for record in records.iter_mut().filter(|r| r.status == "downloading") {
                        record.speed_bps = record.rate.sample(Instant::now(), record.received);
                        active = true;
                    }
                }
                if active {
                    manager.publish();
                }
            }
        });
    }
    pub fn new(app: tauri::AppHandle) -> Self {
        let settings_path = crate::config::portable_root().join("download-settings.json");
        let settings = std::fs::read(&settings_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            app,
            next_id: AtomicU64::new(1),
            records: Mutex::new(Vec::new()),
            last_directory: Mutex::new(None),
            settings: Mutex::new(settings),
            settings_path,
            dialog_gate: tauri::async_runtime::Mutex::new(()),
            reservation_gate: tauri::async_runtime::Mutex::new(()),
            persistence_gate: Mutex::new(()),
            publish_revision: Arc::new(AtomicU64::new(0)),
        }
    }
    pub fn settings(&self) -> DownloadSettings {
        let mut settings = self.settings.lock().unwrap().clone();
        if settings.directory.is_none() {
            settings.directory = self.app.path().download_dir().ok();
        }
        settings
    }
    pub fn set_mode(&self, mode: DownloadMode) -> Result<DownloadSettings, String> {
        let mut settings = self.settings.lock().unwrap().clone();
        settings.mode = mode;
        self.save_settings(settings)?;
        Ok(self.settings())
    }
    fn save_settings(&self, settings: DownloadSettings) -> Result<DownloadSettings, String> {
        // Only serialize writers; the settings lock is never held during disk IO.
        let _persistence = self.persistence_gate.lock().unwrap();
        let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
        std::fs::write(&self.settings_path, bytes)
            .map_err(|e| format!("保存下载设置失败：{e}"))?;
        *self.settings.lock().unwrap() = settings.clone();
        Ok(settings)
    }
    pub async fn choose_directory(&self) -> Result<DownloadSettings, String> {
        let _dialog = self.dialog_gate.lock().await;
        let host = self.app.get_window(MAIN_LABEL).ok_or("主窗口不可用")?;
        let mut settings = self.settings();
        let mut dialog = rfd::AsyncFileDialog::new()
            .set_parent(&host)
            .set_title("选择默认下载目录");
        if let Some(directory) = settings.directory.as_ref() {
            dialog = dialog.set_directory(directory);
        }
        let Some(folder) = dialog.pick_folder().await else {
            return Ok(settings);
        };
        settings.directory = Some(folder.path().to_path_buf());
        self.save_settings(settings)
    }
    pub fn snapshot(&self) -> Vec<DownloadRecord> {
        self.records.lock().unwrap().clone()
    }
    fn publish(&self) {
        // Dispatch Shell updates outside WebView2 COM event handlers.
        let app = self.app.clone();
        let snapshot = self.snapshot();
        let revision = self.publish_revision.fetch_add(1, Ordering::SeqCst) + 1;
        let current = self.publish_revision.clone();
        tauri::async_runtime::spawn(async move {
            if current.load(Ordering::SeqCst) != revision {
                return;
            }
            if let (Some(shell), Ok(json)) =
                (app.get_webview(SHELL_LABEL), serde_json::to_string(&snapshot))
            {
                if current.load(Ordering::SeqCst) == revision {
                    let _ = shell.eval(format!(
                        "window.__AXIVER_SHELL__&&window.__AXIVER_SHELL__.onDownloads({json});"
                    ));
                }
            }
        });
    }
    fn update(&self, id: u64, change: impl FnOnce(&mut DownloadRecord)) {
        if let Some(record) = self.records.lock().unwrap().iter_mut().find(|r| r.id == id) {
            change(record);
        }
        self.publish();
    }
    fn begin(&self, name: String, total: Option<u64>) -> u64 {
        let settings = self.settings();
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut records = self.records.lock().unwrap();
        if records.len() >= 50 {
            if let Some(index) = records
                .iter()
                .position(|r| matches!(r.status.as_str(), "completed" | "cancelled" | "failed"))
            {
                records.remove(index);
            }
        }
        records.push(DownloadRecord {
            id,
            name,
            status: "pending".into(),
            path: None,
            received: 0,
            total,
            speed_bps: 0.0,
            error: None,
            mode: settings.mode,
            directory: settings.directory,
            updated: Instant::now(),
            rate: TransferRate::default(),
        });
        drop(records);
        self.publish();
        id
    }
    pub async fn confirm(self: &Arc<Self>, id: u64) -> Result<(), String> {
        let (name, mode, directory) = {
            let mut records = self.records.lock().unwrap();
            let record = records
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or("下载任务不存在")?;
            if record.status != "pending" {
                return Err("此任务已处理".into());
            }
            (record.name.clone(), record.mode, record.directory.clone())
        };
        if mode == DownloadMode::DefaultLocation {
            // Reserve names serially, but never hold the records lock while
            // checking a slow/filtered filesystem.
            let _reservation = self.reservation_gate.lock().await;
            let directory = directory.ok_or("默认下载目录不可用，请在设置中重新选择")?;
            let occupied = self
                .records
                .lock()
                .unwrap()
                .iter()
                .filter_map(|record| record.path.clone())
                .collect::<Vec<_>>();
            let path = tauri::async_runtime::spawn_blocking(move || {
                if !directory.is_dir() {
                    return Err("默认下载目录不可用，请在设置中重新选择".to_string());
                }
                available_path(&directory, &name, &occupied)
            })
            .await
            .map_err(|error| format!("下载路径检查任务失败：{error}"))??;
            let mut records = self.records.lock().unwrap();
            let record = records
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or("下载任务不存在")?;
            if record.status != "pending" {
                return Err("此任务已处理".into());
            }
            record.path = Some(path.clone());
            record.status = "downloading".into();
            drop(records);
            self.publish();
            let manager = self.clone();
            return self
                .app
                .run_on_main_thread(move || native::resolve(manager, id, Some(path)))
                .map_err(|e| e.to_string());
        }
        let _dialog = self.dialog_gate.lock().await;
        if !self
            .records
            .lock()
            .unwrap()
            .iter()
            .any(|record| record.id == id && record.status == "pending")
        {
            return Err("此任务已处理".into());
        }
        self.update(id, |record| record.status = "choosing".into());
        let parent = self.app.get_window(MAIN_LABEL).ok_or("主窗口不可用")?;
        let mut dialog = rfd::AsyncFileDialog::new()
            .set_parent(&parent)
            .set_title("选择下载保存位置")
            .set_file_name(&name);
        if let Some(directory) = self
            .last_directory
            .lock()
            .unwrap()
            .clone()
            .or(directory)
            .or_else(|| self.app.path().download_dir().ok())
        {
            dialog = dialog.set_directory(directory);
        }
        let selected = dialog
            .save_file()
            .await
            .map(|file| file.path().to_path_buf());
        if let Some(path) = selected.as_ref() {
            *self.last_directory.lock().unwrap() = path.parent().map(|p| p.to_path_buf());
        }
        let manager = self.clone();
        self.app
            .run_on_main_thread(move || native::resolve(manager, id, selected))
            .map_err(|e| e.to_string())
    }
    pub fn cancel(self: &Arc<Self>, id: u64) -> Result<(), String> {
        if !self
            .records
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.id == id && r.status == "pending")
        {
            return Err("只能取消尚未确认的任务".into());
        }
        let manager = self.clone();
        self.app
            .run_on_main_thread(move || native::resolve(manager, id, None))
            .map_err(|e| e.to_string())
    }
    pub fn reveal(&self, id: u64) -> Result<(), String> {
        let record = self
            .records
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.id == id)
            .cloned()
            .ok_or("下载任务不存在")?;
        let path = record
            .path
            .filter(|_| record.status == "completed")
            .ok_or("下载完成后可以打开保存位置")?;
        if !path.is_file() {
            return Err("文件已移动或删除".into());
        }
        native::reveal(path)
    }
}

fn available_path(
    directory: &std::path::Path,
    name: &str,
    occupied: &[PathBuf],
) -> Result<PathBuf, String> {
    let name = std::path::Path::new(name)
        .file_name()
        .ok_or("下载文件名无效")?;
    let original = directory.join(name);
    if !original.exists() && !occupied.contains(&original) {
        return Ok(original);
    }
    let path = std::path::Path::new(name);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let extension = path
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()))
        .unwrap_or_default();
    for number in 1..10000 {
        let candidate = directory.join(format!("{stem} ({number}){extension}"));
        if !candidate.exists() && !occupied.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err("同名文件过多，请更换下载目录".into())
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{cell::RefCell, collections::HashMap};
    use webview2_com::{
        BytesReceivedChangedEventHandler, DownloadStartingEventHandler,
        Microsoft::Web::WebView2::Win32::*, StateChangedEventHandler, take_pwstr,
    };
    use windows::{
        Win32::System::Com::{
            COINIT_APARTMENTTHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize,
        },
        core::{HSTRING, Interface, PWSTR},
    };
    thread_local! { static WAITING:RefCell<HashMap<u64,(ICoreWebView2DownloadStartingEventArgs,ICoreWebView2Deferral)>>=RefCell::new(HashMap::new()); }

    pub fn install(view: &tauri::Webview, manager: Arc<DownloadManager>) -> tauri::Result<()> {
        view.with_webview(move|platform|unsafe {
            let install=||->windows::core::Result<()> {
                let webview:ICoreWebView2_4=platform.controller().CoreWebView2()?.cast()?;
                webview.add_DownloadStarting(&DownloadStartingEventHandler::create(Box::new(move|_,args| {
                    let Some(args)=args else{return Ok(())};
                    args.SetHandled(true)?;
                    // Avoid an unbounded queue of deferred requests from a remote page.
                    if WAITING.with(|pending|pending.borrow().len()>=20) { args.SetCancel(true)?; return Ok(()); }
                    let operation=args.DownloadOperation()?;
                    let mut raw=PWSTR::null(); args.ResultFilePath(&mut raw)?;
                    let original=PathBuf::from(take_pwstr(raw));
                    let name=original.file_name().unwrap_or_default().to_string_lossy().to_string();
                    let mut total=0; operation.TotalBytesToReceive(&mut total)?;
                    let id=manager.begin(if name.is_empty(){"AXIVER-download".into()}else{name},u64::try_from(total).ok().filter(|size|*size>0));
                    let deferral=args.GetDeferral()?;
                    WAITING.with(|pending|{pending.borrow_mut().insert(id,(args,deferral));});
                    let changes=manager.clone();
                    operation.add_StateChanged(&StateChangedEventHandler::create(Box::new(move|operation,_|{
                        let Some(operation)=operation else{return Ok(())};
                        let mut state=COREWEBVIEW2_DOWNLOAD_STATE::default(); operation.State(&mut state)?;
                        if state==COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                            let mut path=PWSTR::null();operation.ResultFilePath(&mut path)?;
                            let path=PathBuf::from(take_pwstr(path));
                            changes.update(id,|r|{
                                r.status="completed".into();
                                r.speed_bps=0.0;
                                r.name=path.file_name().unwrap_or_default().to_string_lossy().to_string();
                                r.path=Some(path.clone());
                                // Do not query the disk from the COM completion handler.
                                if r.total.is_none() && r.received>0 {r.total=Some(r.received);}
                            });
                        } else if state==COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
                            let mut reason=COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON::default();operation.InterruptReason(&mut reason)?;
                            changes.update(id,|r|{
                                r.speed_bps=0.0;
                                if r.status!="cancelled" {
                                    r.status=if reason==COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED{"cancelled"}else{"failed"}.into();
                                    if r.status=="failed"{r.error=Some(format!("下载中断（{}），请重新发起",reason.0));}
                                }
                            });
                        }
                        Ok(())
                    })),&mut 0)?;
                    let progress=manager.clone();
                    operation.add_BytesReceivedChanged(&BytesReceivedChangedEventHandler::create(Box::new(move|operation,_|{
                        let Some(operation)=operation else{return Ok(())};let mut received=0;operation.BytesReceived(&mut received)?;
                        let mut total=0;operation.TotalBytesToReceive(&mut total)?;
                        let mut records=progress.records.lock().unwrap();
                        let mut publish=false;
                        if let Some(record)=records.iter_mut().find(|r|r.id==id) {
                            record.received=received.max(0) as u64;
                            record.total=u64::try_from(total).ok().filter(|size|*size>0).or(record.total);
                            if record.status=="downloading" {record.speed_bps=record.rate.sample(Instant::now(),record.received);}
                            if record.updated.elapsed().as_millis()>=150 {record.updated=Instant::now();publish=true;}
                        }
                        drop(records);if publish{progress.publish();}Ok(())
                    })),&mut 0)?;
                    if manager.snapshot().iter().any(|record|record.id==id&&record.mode==DownloadMode::AskEachTime) {
                        let choosing=manager.clone();
                        tauri::async_runtime::spawn(async move {let _=choosing.confirm(id).await;});
                    }
                    Ok(())
                })),&mut 0)?; Ok(())
            };
            if let Err(error)=install(){eprintln!("native download handler: {error}");}
        })
    }
    // Invoked exclusively on the WebView2 owning UI thread, including COM deferrals.
    pub fn resolve(manager: Arc<DownloadManager>, id: u64, path: Option<PathBuf>) {
        let slot = WAITING.with(|pending| pending.borrow_mut().remove(&id));
        if let Some((args, deferral)) = slot {
            let result = unsafe {
                if let Some(path) = path {
                    let result = args.SetResultFilePath(&HSTRING::from(path.as_os_str()));
                    if result.is_ok() {
                        manager.update(id, |r| {
                            r.path = Some(path);
                            r.status = "downloading".into();
                            r.rate.reset(Instant::now(), r.received);
                            r.speed_bps = 0.0;
                        });
                    }
                    result
                } else {
                    manager.update(id, |r| r.status = "cancelled".into());
                    args.SetCancel(true)
                }
            };
            if let Err(error) = result {
                manager.update(id, |r| {
                    r.status = "failed".into();
                    r.error = Some(error.to_string());
                });
                unsafe {
                    let _ = args.SetCancel(true);
                }
            }
            unsafe {
                let _ = deferral.Complete();
            }
        }
    }
    pub fn reveal(path: PathBuf) -> Result<(), String> {
        use windows::Win32::UI::Shell::{
            ILCreateFromPathW, ILFindLastID, SHOpenFolderAndSelectItems,
        };
        unsafe {
            let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let full = ILCreateFromPathW(&HSTRING::from(path.as_os_str()));
            let folder = ILCreateFromPathW(&HSTRING::from(
                path.parent().ok_or("保存目录不可用")?.as_os_str(),
            ));
            let result = if full.is_null() || folder.is_null() {
                Err("无法打开保存位置".into())
            } else {
                SHOpenFolderAndSelectItems(folder, Some(&[ILFindLastID(full)]), 0)
                    .map_err(|e| e.to_string())
            };
            CoTaskMemFree(Some(full.cast()));
            CoTaskMemFree(Some(folder.cast()));
            if initialized {
                CoUninitialize();
            }
            result
        }
    }
}

#[cfg(windows)]
pub use native::install;
#[cfg(not(windows))]
mod native {
    use super::*;
    pub fn resolve(_: Arc<DownloadManager>, _: u64, _: Option<PathBuf>) {}
    pub fn reveal(_: PathBuf) -> Result<(), String> {
        Err("Unsupported platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn speed_uses_transfer_window_and_decays_when_stalled() {
        let now = Instant::now();
        let mut rate = TransferRate::default();
        rate.reset(now, 2048);
        assert_eq!(
            rate.sample(now + std::time::Duration::from_millis(500), 3072),
            2048.0
        );
        assert_eq!(
            rate.sample(now + std::time::Duration::from_secs(1), 4096),
            2048.0
        );
        rate.sample(now + std::time::Duration::from_millis(1500), 4096);
        assert_eq!(
            rate.sample(now + std::time::Duration::from_secs(2), 4096),
            0.0
        );
        rate.reset(now + std::time::Duration::from_secs(30), 4096);
        assert_eq!(
            rate.sample(now + std::time::Duration::from_millis(30500), 4608),
            1024.0
        );
    }
    #[test]
    fn default_location_never_reuses_existing_or_reserved_names() {
        let directory = std::env::temp_dir().join(format!(
            "axiver-download-name-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let original = directory.join("文件.txt");
        std::fs::write(&original, b"keep").unwrap();
        let reserved = directory.join("文件 (1).txt");
        assert_eq!(
            available_path(&directory, "文件.txt", &[reserved]).unwrap(),
            directory.join("文件 (2).txt")
        );
        assert_eq!(std::fs::read(&original).unwrap(), b"keep");
        std::fs::remove_file(original).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
