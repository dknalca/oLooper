use std::io::Write;
use std::path::Path;

fn copy_managed_audio_to_destination(source: &Path, destination: &Path) -> Result<(), String> {
    let source_metadata = std::fs::symlink_metadata(source)
        .map_err(|error| format!("cannot inspect managed audio: {error}"))?;
    let canonical_source = source
        .canonicalize()
        .map_err(|error| format!("cannot resolve managed audio: {error}"))?;
    if source_metadata.file_type().is_symlink()
        || !source_metadata.is_file()
        || source_metadata.len() > 512 * 1024 * 1024
        || canonical_source != source
    {
        return Err("managed audio is not a valid desktop drag source".to_string());
    }
    let mut input = std::fs::File::open(source)
        .map_err(|error| format!("cannot read managed audio: {error}"))?;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("cannot create desktop audio copy: {error}"))?;
    let result = std::io::copy(&mut input, &mut output)
        .and_then(|_| output.flush())
        .and_then(|_| output.sync_all())
        .map_err(|error| format!("cannot write desktop audio copy: {error}"));
    if result.is_err() {
        let _ = std::fs::remove_file(destination);
    }
    result.map(|_| ())
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
mod macos {
    use cocoa::appkit::NSApp;
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSArray, NSAutoreleasePool, NSPoint, NSRect, NSSize, NSString};
    use dispatch::Queue;
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Protocol, Sel};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::os::raw::c_char;
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;

    const NS_DRAG_OPERATION_COPY: u64 = 1;

    pub fn start_file_drag_out(path: &Path) -> Result<(), String> {
        let path = path.to_path_buf();
        let is_main_thread: bool = unsafe { msg_send![class!(NSThread), isMainThread] };
        if is_main_thread {
            return start_on_main_thread(&path);
        }

        let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel(1);
        Queue::main().exec_async(move || {
            let result = start_on_main_thread(&path);
            let _ = reply_tx.send(result);
        });
        reply_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| format!("cannot start Finder drag: {error}"))?
    }

    fn start_on_main_thread(path: &Path) -> Result<(), String> {
        unsafe {
            let pool = NSAutoreleasePool::new(nil);
            let result = (|| {
                let app: id = NSApp();
                if app == nil {
                    return Err("macOS application object is unavailable".to_string());
                }
                let mut window: id = msg_send![app, keyWindow];
                if window == nil {
                    let windows: id = msg_send![app, orderedWindows];
                    if windows != nil {
                        let count: usize = msg_send![windows, count];
                        if count > 0 {
                            window = msg_send![windows, objectAtIndex:0usize];
                        }
                    }
                }
                if window == nil {
                    return Err("application window is unavailable".to_string());
                }
                let view: id = msg_send![window, contentView];
                let event: id = msg_send![app, currentEvent];
                if view == nil || event == nil {
                    return Err(
                        "cannot start file drag without an active pointer event".to_string()
                    );
                }

                let path_string = path.to_string_lossy();
                let path_ns = NSString::alloc(nil).init_str(&path_string);
                let _: id = msg_send![path_ns, retain];
                let delegate_class = dragging_source_class();
                let delegate: id = msg_send![delegate_class, new];
                (*delegate).set_ivar("path", path_ns);

                let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
                let file_type: id = msg_send![workspace, typeOfFile:path_ns error:nil];
                let file_type = if file_type == nil {
                    NSString::alloc(nil).init_str("public.data")
                } else {
                    file_type
                };
                let provider: id = msg_send![class!(NSFilePromiseProvider), alloc];
                let provider: id =
                    msg_send![provider, initWithFileType:file_type delegate:delegate];
                if provider == nil {
                    release_drag_source(delegate);
                    return Err("macOS could not prepare the audio file promise".to_string());
                }
                let icon: id = msg_send![workspace, iconForFile:path_ns];
                if icon != nil {
                    let _: () = msg_send![icon, setSize:NSSize::new(48.0, 48.0)];
                }
                let window_point: NSPoint = msg_send![event, locationInWindow];
                let view_point: NSPoint = msg_send![view, convertPoint:window_point fromView:nil];
                let frame = NSRect::new(view_point, NSSize::new(1.0, 1.0));
                let item: id = msg_send![class!(NSDraggingItem), alloc];
                let item: id = msg_send![item, initWithPasteboardWriter:provider];
                let _: () = msg_send![item, setDraggingFrame:frame contents:icon];
                let items = NSArray::arrayWithObject(nil, item);
                let session: id = msg_send![view, beginDraggingSessionWithItems:items event:event source:delegate];
                if session == nil {
                    release_drag_source(delegate);
                    return Err("macOS did not start the Finder drag session".to_string());
                }
                Ok(())
            })();
            pool.drain();
            result
        }
    }

    fn dragging_source_class() -> &'static Class {
        static CLASS: OnceLock<&'static Class> = OnceLock::new();
        CLASS.get_or_init(|| unsafe {
            let mut declaration =
                ClassDecl::new("OLooperFilePromiseSource", class!(NSObject)).unwrap();
            declaration.add_protocol(Protocol::get("NSDraggingSource").unwrap());
            declaration.add_protocol(Protocol::get("NSFilePromiseProviderDelegate").unwrap());
            declaration.add_ivar::<*mut Object>("path");

            extern "C" fn source_operation(
                _this: &Object,
                _selector: Sel,
                _session: id,
                _context: u64,
            ) -> u64 {
                NS_DRAG_OPERATION_COPY
            }
            declaration.add_method(
                sel!(draggingSession:sourceOperationMaskForDraggingContext:),
                source_operation as extern "C" fn(&Object, Sel, id, u64) -> u64,
            );

            extern "C" fn promised_file_name(
                this: &Object,
                _selector: Sel,
                _provider: id,
                _file_type: id,
            ) -> id {
                unsafe {
                    let path: *mut Object = *this.get_ivar("path");
                    if path.is_null() {
                        return nil;
                    }
                    let name: id = msg_send![path as id, lastPathComponent];
                    msg_send![name, copy]
                }
            }
            declaration.add_method(
                sel!(filePromiseProvider:fileNameForType:),
                promised_file_name as extern "C" fn(&Object, Sel, id, id) -> id,
            );

            extern "C" fn write_file_promise(
                this: &Object,
                _selector: Sel,
                _provider: id,
                destination_url: id,
                completion_handler: id,
            ) {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
                    let source: *mut Object = *this.get_ivar("path");
                    if source.is_null() {
                        return Err("drag source path is unavailable".to_string());
                    }
                    let source_string: *const c_char = msg_send![source as id, UTF8String];
                    let destination_path: id = msg_send![destination_url, path];
                    let destination_string: *const c_char = msg_send![destination_path, UTF8String];
                    if source_string.is_null() || destination_string.is_null() {
                        return Err("macOS returned an invalid file-promise path".to_string());
                    }
                    let source_path =
                        PathBuf::from(CStr::from_ptr(source_string).to_string_lossy().into_owned());
                    let destination = PathBuf::from(
                        CStr::from_ptr(destination_string)
                            .to_string_lossy()
                            .into_owned(),
                    );
                    super::copy_managed_audio_to_destination(&source_path, &destination)
                }));
                let error = match result {
                    Ok(Ok(())) => nil,
                    Ok(Err(message)) => promise_error(&message),
                    Err(_) => promise_error("panic while writing promised audio file"),
                };
                finish_file_promise(completion_handler, error);
            }
            declaration.add_method(
                sel!(filePromiseProvider:writePromiseToURL:completionHandler:),
                write_file_promise as extern "C" fn(&Object, Sel, id, id, id),
            );

            extern "C" fn drag_ended(
                this: &Object,
                _selector: Sel,
                _session: id,
                _point: NSPoint,
                _operation: u64,
            ) {
                unsafe { release_drag_source(this as *const Object as id) };
            }
            declaration.add_method(
                sel!(draggingSession:endedAt:operation:),
                drag_ended as extern "C" fn(&Object, Sel, id, NSPoint, u64),
            );
            declaration.register()
        })
    }

    unsafe fn release_drag_source(delegate: id) {
        let delegate_object = &*(delegate as *const Object);
        let path: *mut Object = *delegate_object.get_ivar("path");
        if !path.is_null() {
            let _: () = msg_send![path, release];
        }
        let _: () = msg_send![delegate, release];
    }

    fn promise_error(message: &str) -> id {
        unsafe {
            let domain = NSString::alloc(nil).init_str("com.olooper.drag-out");
            let description = NSString::alloc(nil).init_str(message);
            let description_key = NSString::alloc(nil).init_str("NSLocalizedDescription");
            let info: id = msg_send![class!(NSDictionary), dictionaryWithObject:description forKey:description_key];
            msg_send![class!(NSError), errorWithDomain:domain code:1 userInfo:info]
        }
    }

    fn finish_file_promise(completion_handler: id, error: id) {
        if completion_handler == nil {
            return;
        }
        #[repr(C)]
        struct BlockLiteral {
            isa: *const std::ffi::c_void,
            flags: i32,
            reserved: i32,
            invoke: extern "C" fn(*mut BlockLiteral, id),
        }
        unsafe {
            let block = completion_handler as *mut BlockLiteral;
            ((*block).invoke)(block, error);
        }
    }
}

pub fn start_file_drag_out(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return macos::start_file_drag_out(path);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("dragging library audio to the desktop is currently supported on macOS".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_copy_preserves_source_and_never_overwrites_destination() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("managed.wav");
        let destination = root.path().join("Desktop copy.wav");
        std::fs::write(&source, b"managed audio bytes").unwrap();

        copy_managed_audio_to_destination(&source.canonicalize().unwrap(), &destination).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), b"managed audio bytes");
        assert_eq!(std::fs::read(&destination).unwrap(), b"managed audio bytes");
        assert!(copy_managed_audio_to_destination(&source, &destination).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"managed audio bytes");
    }

    #[cfg(unix)]
    #[test]
    fn desktop_copy_rejects_symlinked_sources() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("outside.wav");
        let symlink = root.path().join("managed.wav");
        let destination = root.path().join("Desktop copy.wav");
        std::fs::write(&source, b"outside source").unwrap();
        std::os::unix::fs::symlink(&source, &symlink).unwrap();

        assert!(copy_managed_audio_to_destination(&symlink, &destination).is_err());
        assert!(!destination.exists());
        assert_eq!(std::fs::read(&source).unwrap(), b"outside source");
    }
}
