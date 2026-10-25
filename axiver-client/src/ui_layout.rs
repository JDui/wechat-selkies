//! One native window, with a bounded local control surface above the remote view.
use crate::protocol::{MAIN_LABEL, REMOTE_LABEL, SHELL_LABEL, TOOL_LABEL};
use serde::Serialize;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Rect};

pub const DOT_RESET_DELAY: Duration = Duration::from_secs(10);
const MARGIN: f64 = 12.0;
const PILL_WIDTH: f64 = 128.0;
const PILL_HEIGHT: f64 = 26.0;

#[derive(Default)]
struct UiState {
    expanded: bool,
    x: f64,
    y: f64,
    drag_origin: Option<(f64, f64)>,
    tool_active: bool,
    panel_height: Option<f64>,
    pill_width: Option<f64>,
    returning: bool,
    reduced_motion: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub expanded: bool,
    pub tool_active: bool,
    pub x: f64,
    pub y: f64,
    pub view_x: f64,
    pub view_y: f64,
    pub width: f64,
    pub height: f64,
    pub pill_x: f64,
    pub pill_y: f64,
    pub panel_x: f64,
    pub panel_y: f64,
    pub panel_width: f64,
    pub panel_height: f64,
}

fn placement(state: &mut UiState, width: f64, height: f64) -> Placement {
    let pill_width = state.pill_width.unwrap_or(PILL_WIDTH);
    let edge = if state.returning { 2.0 } else { MARGIN };
    state.x = state.x.clamp(edge, (width - pill_width - edge).max(edge));
    state.y = state.y.clamp(edge, (height - PILL_HEIGHT - edge).max(edge));
    let mut panel_width = 360.0_f64.min((width - 2.0 * MARGIN).max(1.0));
    let panel_height = state
        .panel_height
        .unwrap_or(330.0)
        .min((height - PILL_HEIGHT - 3.0 * MARGIN).max(1.0));
    let mut px = state.x.min(width - panel_width - MARGIN).max(MARGIN);
    let below = state.y + PILL_HEIGHT + 8.0;
    let py = if below + panel_height <= height - MARGIN {
        below
    } else if state.y - panel_height - 8.0 >= MARGIN {
        state.y - panel_height - 8.0
    } else if !state.expanded {
        below
    } else {
        // Keep the dragged pill in place. Use a side card when neither
        // vertical direction fits, rather than prematurely resetting it.
        let right_space = (width - state.x - pill_width - 8.0 - MARGIN).max(1.0);
        let left_space = (state.x - 8.0 - MARGIN).max(1.0);
        if right_space >= left_space {
            panel_width = panel_width.min(right_space);
            px = state.x + pill_width + 8.0;
        } else {
            panel_width = panel_width.min(left_space);
            px = state.x - panel_width - 8.0;
        }
        state
            .y
            .clamp(MARGIN, (height - panel_height - MARGIN).max(MARGIN))
    };
    let (vx, vy, vw, vh) = if state.expanded {
        let left = state.x.min(px);
        let top = state.y.min(py);
        (
            left,
            top,
            (state.x + pill_width).max(px + panel_width) - left,
            (state.y + PILL_HEIGHT).max(py + panel_height) - top,
        )
    } else {
        (state.x, state.y, pill_width, PILL_HEIGHT)
    };
    Placement {
        expanded: state.expanded,
        tool_active: state.tool_active,
        x: state.x,
        y: state.y,
        view_x: vx,
        view_y: vy,
        width: vw,
        height: vh,
        pill_x: state.x - vx,
        pill_y: state.y - vy,
        panel_x: px - vx,
        panel_y: py - vy,
        panel_width,
        panel_height,
    }
}

pub struct UiController {
    app: AppHandle,
    state: Mutex<UiState>,
    reset_generation: AtomicU64,
    native_bounds: Arc<Mutex<Option<(f64, f64, f64, f64, bool)>>>,
    bounds_generation: Arc<AtomicU64>,
}

impl UiController {
    pub fn is_expanded(&self) -> bool {
        self.state.lock().unwrap().expanded
    }
    pub fn tool_active(&self) -> bool {
        self.state.lock().unwrap().tool_active
    }
    pub fn set_reduced_motion(&self, value: bool) {
        self.state.lock().unwrap().reduced_motion = value;
    }
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            state: Mutex::new(UiState {
                x: MARGIN,
                y: MARGIN,
                ..Default::default()
            }),
            reset_generation: AtomicU64::new(0),
            native_bounds: Arc::new(Mutex::new(None)),
            bounds_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn apply(&self) -> tauri::Result<Placement> {
        let window = self.app.get_window(MAIN_LABEL).expect("main window exists");
        let size = window
            .inner_size()?
            .to_logical::<f64>(window.scale_factor()?);
        let result = placement(&mut self.state.lock().unwrap(), size.width, size.height);
        if let Some(shell) = self.app.get_webview(SHELL_LABEL) {
            // Keep the previous viewport until a shrinking card has finished
            // its CSS height transition; transparent space lasts only 340ms.
            let desired = (
                result.view_x,
                result.view_y,
                result.width,
                result.height,
                result.expanded,
            );
            let previous = *self.native_bounds.lock().unwrap();
            let keep = previous.filter(|old| {
                old.4
                    && result.expanded
                    && old.0 == result.view_x
                    && old.1 == result.view_y
                    && (old.2 > result.width || old.3 > result.height)
                    && !self.state.lock().unwrap().reduced_motion
            });
            let actual = keep
                .map(|old| {
                    (
                        desired.0,
                        desired.1,
                        old.2.max(desired.2),
                        old.3.max(desired.3),
                        true,
                    )
                })
                .unwrap_or(desired);
            *self.native_bounds.lock().unwrap() = Some(actual);
            let generation = self.bounds_generation.fetch_add(1, Ordering::SeqCst) + 1;
            shell.set_bounds(Rect {
                position: LogicalPosition::new(result.view_x, result.view_y).into(),
                size: LogicalSize::new(actual.2, actual.3).into(),
            })?;
            if keep.is_some() {
                let epoch = self.bounds_generation.clone();
                let saved = self.native_bounds.clone();
                let app = self.app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(340));
                    if epoch.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    if let Some(view) = app.get_webview(SHELL_LABEL) {
                        let _ = view.set_bounds(Rect {
                            position: LogicalPosition::new(desired.0, desired.1).into(),
                            size: LogicalSize::new(desired.2, desired.3).into(),
                        });
                        *saved.lock().unwrap() = Some(desired);
                    }
                });
            }
            let json = serde_json::to_string(&result).unwrap();
            shell.eval(format!(
                "window.__AXIVER_SHELL__&&window.__AXIVER_SHELL__.onLayout({json});"
            ))?;
        }
        Ok(result)
    }

    pub fn resize(&self) {
        if let Some(window) = self.app.get_window(MAIN_LABEL) {
            if let Ok(size) = window.inner_size() {
                for label in [REMOTE_LABEL, TOOL_LABEL] {
                    if let Some(view) = self.app.get_webview(label) {
                        let _ = view.set_size(size);
                    }
                }
            }
        }
        let _ = self.apply();
    }

    pub fn set_expanded(&self, expanded: bool) -> tauri::Result<Placement> {
        self.state.lock().unwrap().expanded = expanded;
        let result = self.apply()?;
        if let Some(view) = self.app.get_webview(if expanded {
            SHELL_LABEL
        } else if result.tool_active {
            TOOL_LABEL
        } else {
            REMOTE_LABEL
        }) {
            let _ = view.set_focus();
        }
        Ok(result)
    }

    pub fn toggle(&self) -> tauri::Result<Placement> {
        let expanded = !self.state.lock().unwrap().expanded;
        self.set_expanded(expanded)
    }

    pub fn set_panel_height(&self, height: f64) -> tauri::Result<Placement> {
        self.state.lock().unwrap().panel_height = Some(height.clamp(240.0, 540.0));
        self.apply()
    }

    pub fn set_pill_width(&self, width: f64) -> tauri::Result<Placement> {
        self.state.lock().unwrap().pill_width = Some(width.ceil().clamp(48.0, 240.0));
        self.apply()
    }

    pub fn drag_start(&self) {
        let mut state = self.state.lock().unwrap();
        self.reset_generation.fetch_add(1, Ordering::SeqCst);
        state.drag_origin = Some((state.x, state.y));
        state.returning = false;
        state.expanded = false;
    }

    pub fn drag_move(&self, dx: f64, dy: f64) -> tauri::Result<Placement> {
        let mut state = self.state.lock().unwrap();
        if let Some((x, y)) = state.drag_origin {
            state.x = x + dx;
            state.y = y + dy;
        }
        drop(state);
        self.apply()
    }

    pub fn drag_end(self: &Arc<Self>) -> tauri::Result<Placement> {
        let mut state = self.state.lock().unwrap();
        state.drag_origin = None;
        let generation = self.reset_generation.fetch_add(1, Ordering::SeqCst) + 1;
        drop(state);
        let ui = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(DOT_RESET_DELAY);
            ui.animate_home(generation);
        });
        self.apply()
    }

    pub fn reset(self: &Arc<Self>) -> tauri::Result<Placement> {
        let mut state = self.state.lock().unwrap();
        let generation = self.reset_generation.fetch_add(1, Ordering::SeqCst) + 1;
        state.drag_origin = None;
        drop(state);
        let ui = self.clone();
        std::thread::spawn(move || ui.animate_home(generation));
        self.apply()
    }

    fn animate_home(&self, generation: u64) {
        let (x, y, reduced) = {
            let mut state = self.state.lock().unwrap();
            if self.reset_generation.load(Ordering::SeqCst) != generation
                || state.drag_origin.is_some()
            {
                return;
            }
            state.returning = true;
            (state.x, state.y, state.reduced_motion)
        };
        let frames = if reduced { 1 } else { 40 };
        for frame in 1..=frames {
            if !reduced {
                std::thread::sleep(Duration::from_millis(16));
            }
            let mut state = self.state.lock().unwrap();
            if self.reset_generation.load(Ordering::SeqCst) != generation
                || state.drag_origin.is_some()
            {
                state.returning = false;
                return;
            }
            let t = frame as f64 / frames as f64;
            let remaining = if frame == frames {
                0.0
            } else {
                (-7.0 * t).exp() * ((10.0 * t).cos() + 0.4 * (10.0 * t).sin())
            };
            let offset = |distance: f64| {
                let raw = distance * remaining;
                if raw < 0.0 {
                    -6.0 * (1.0 - (raw / 6.0).exp())
                } else {
                    raw
                }
            };
            state.x = MARGIN + offset(x - MARGIN);
            state.y = MARGIN + offset(y - MARGIN);
            if frame == frames {
                state.returning = false;
            }
            drop(state);
            let _ = self.apply();
        }
    }

    pub fn open_tool(&self, url: url::Url) -> tauri::Result<()> {
        if let Some(tool) = self.app.get_webview(TOOL_LABEL) {
            tool.navigate(url)?;
            tool.show()?;
            let _ = tool.set_focus();
            self.state.lock().unwrap().tool_active = true;
            let _ = self.set_expanded(false);
        }
        Ok(())
    }

    pub fn close_tool(&self) {
        let mut state = self.state.lock().unwrap();
        if !state.tool_active {
            return;
        }
        state.tool_active = false;
        drop(state);
        if let Some(tool) = self.app.get_webview(TOOL_LABEL) {
            let _ = tool.hide();
        }
        if let Some(remote) = self.app.get_webview(REMOTE_LABEL) {
            let _ = remote.set_focus();
        }
        let _ = self.apply();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn floating_controls_remain_inside_small_and_large_windows() {
        for (w, h) in [(820.0, 560.0), (1280.0, 820.0)] {
            for (x, y) in [
                (12.0, 12.0),
                (1200.0, 780.0),
                (-40.0, -90.0),
                (400.0, 250.0),
            ] {
                for expanded in [false, true] {
                    for pill_width in [78.0, 112.0, 240.0] {
                        let mut s = UiState {
                            x,
                            y,
                            expanded,
                            pill_width: Some(pill_width),
                            ..Default::default()
                        };
                        let p = placement(&mut s, w, h);
                        assert!(p.view_x >= 0.0 && p.view_y >= 0.0);
                        assert!(p.view_x + p.width <= w && p.view_y + p.height <= h);
                        assert_eq!(p.x, x.clamp(MARGIN, w - pill_width - MARGIN));
                        assert_eq!(p.y, y.clamp(MARGIN, h - PILL_HEIGHT - MARGIN));
                    }
                }
            }
        }
        assert_eq!(DOT_RESET_DELAY.as_secs(), 10);
    }
}
