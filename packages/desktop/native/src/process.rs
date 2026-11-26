//! Processes: whether one runs, when it started (which tells it from a
//! later process the OS gives the same id), and whether its environment
//! carries a launch token. macOS hides the environment of its own apps and
//! of builds signed with the `restrict` flag: that answers `None`, no
//! evidence either way. Their arguments stay readable.

/// Whether a process with this id exists, this user's or another's.
pub fn alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// When a process started, in microseconds since the epoch; `None` when it is not running.
pub fn started(pid: i32) -> Option<u64> {
    if pid <= 0 {
        return None;
    }
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let read = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
    if read != size {
        return None;
    }
    Some(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
}

/// A process's arguments (after the executable path) and its environment; the environment is `None` when macOS hides it,
/// and the whole answer `None` when the process cannot be read.
fn procargs(pid: i32) -> Option<(Vec<String>, Option<Vec<String>>)> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size: libc::size_t = 0;
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0 || size < 4 {
        return None;
    }
    let mut buffer = vec![0u8; size];
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buffer.as_mut_ptr() as *mut libc::c_void, &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    buffer.truncate(size);
    let argc = i32::from_ne_bytes(buffer[0..4].try_into().ok()?) as usize;
    let mut strings = buffer[4..].split(|byte| *byte == 0).filter(|part| !part.is_empty());
    // The executable path, then argv (its first entry the executable again), then the environment.
    strings.next()?;
    let mut rest: Vec<String> = strings.map(|part| String::from_utf8_lossy(part).into_owned()).collect();
    let environment = rest.split_off(argc.min(rest.len()));
    let arguments = rest.into_iter().skip(1).collect();
    // A restricted process shows its arguments alone: no variable a real environment always has.
    let shown = environment.iter().any(|entry| entry.starts_with("HOME=") || entry.starts_with("PATH=") || entry.starts_with("USER="));
    Some((arguments, shown.then_some(environment)))
}

/// A process's environment, `None` when it cannot be read.
fn environment(pid: i32) -> Option<Vec<String>> {
    procargs(pid)?.1
}

/// Whether a process's arguments hold `name` followed by `value`.
pub fn argument_pair(pid: i32, name: &str, value: &str) -> bool {
    procargs(pid).is_some_and(|(arguments, _)| arguments.windows(2).any(|pair| pair[0] == name && pair[1] == value))
}

/// Whether a process's environment holds `marker` (`NAME=value`); `None` when it cannot be read.
pub fn carries(pid: i32, marker: &str) -> Option<bool> {
    environment(pid).map(|entries| entries.iter().any(|entry| entry == marker))
}

/// Every process of this user whose environment holds `marker`; `None` when the processes cannot be listed.
pub fn carrying(marker: &str) -> Option<Vec<i32>> {
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return None;
    }
    let mut pids = vec![0i32; count as usize + 64];
    let filled = unsafe { libc::proc_listallpids(pids.as_mut_ptr() as *mut libc::c_void, (pids.len() * std::mem::size_of::<i32>()) as i32) };
    if filled <= 0 {
        return None;
    }
    pids.truncate(filled as usize);
    let own = std::process::id() as i32;
    Some(pids.into_iter().filter(|pid| *pid > 0 && *pid != own && carries(*pid, marker) == Some(true)).collect())
}
