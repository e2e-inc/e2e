//! The copies of an app macOS knows by bundle id: the bundles LaunchServices
//! has registered, and the processes running one. Replacing an app's saved
//! state reaches every copy with its bundle id, since they share one defaults
//! domain, so the engine refuses while another copy exists.

use objc2_app_kit::{NSRunningApplication, NSWorkspace};
use objc2_foundation::NSString;
use serde::Serialize;

/// One running copy.
#[derive(Serialize)]
pub struct Running {
    pub pid: i32,
    /// Its bundle on disk, when it has one.
    pub path: Option<String>,
}

/// What LaunchServices knows of a bundle id.
#[derive(Serialize)]
pub struct Copies {
    /// Every bundle registered with the id, as paths; a registration can outlive the bundle it names.
    pub registered: Vec<String>,
    pub running: Vec<Running>,
}

pub fn copies(bundle_id: &str) -> Copies {
    let id = NSString::from_str(bundle_id);
    let registered =
        NSWorkspace::sharedWorkspace().URLsForApplicationsWithBundleIdentifier(&id).iter().filter_map(|url| url.path().map(|path| path.to_string())).collect();
    let running = NSRunningApplication::runningApplicationsWithBundleIdentifier(&id)
        .iter()
        .map(|app| Running { pid: app.processIdentifier(), path: app.bundleURL().and_then(|url| url.path()).map(|path| path.to_string()) })
        .collect();
    Copies { registered, running }
}
