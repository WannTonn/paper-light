#[cfg(target_os = "windows")]
#[tauri::command]
fn list_printers() -> Result<Vec<String>, String> {
    use std::{mem::size_of, slice};
    use windows::{
        core::PCWSTR,
        Win32::Graphics::Printing::{
            EnumPrintersW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_INFO_4W,
        },
    };

    unsafe {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut bytes_needed = 0u32;
        let mut count = 0u32;
        let _ = EnumPrintersW(
            flags,
            PCWSTR::null(),
            4,
            None,
            &mut bytes_needed,
            &mut count,
        );
        if bytes_needed == 0 {
            return Ok(Vec::new());
        }

        // u64 backing storage keeps PRINTER_INFO_4W correctly aligned while
        // still providing the byte buffer required by EnumPrintersW.
        let words = (bytes_needed as usize + size_of::<u64>() - 1) / size_of::<u64>();
        let mut storage = vec![0u64; words];
        let buffer = slice::from_raw_parts_mut(storage.as_mut_ptr().cast::<u8>(), bytes_needed as usize);
        EnumPrintersW(
            flags,
            PCWSTR::null(),
            4,
            Some(buffer),
            &mut bytes_needed,
            &mut count,
        )
        .map_err(|error| format!("无法读取 Windows 打印机列表：{error}"))?;

        let entries = slice::from_raw_parts(storage.as_ptr().cast::<PRINTER_INFO_4W>(), count as usize);
        let mut printers = entries
            .iter()
            .filter_map(|entry| entry.pPrinterName.to_string().ok())
            .filter(|name| !name.trim().is_empty())
            .collect::<Vec<_>>();
        printers.sort_unstable_by_key(|name| name.to_lowercase());
        printers.dedup();
        Ok(printers)
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn list_printers() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![list_printers])
        .run(tauri::generate_context!())
        .expect("error while running Paperlight");
}
