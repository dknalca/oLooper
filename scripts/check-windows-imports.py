#!/usr/bin/env python3
"""Diagnose missing direct DLL exports in a trusted CI-built PE executable."""
import ctypes
import pathlib
import struct
import sys


def imports(path):
    data = pathlib.Path(path).read_bytes()
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    section_count, optional_size = struct.unpack_from("<H12xH", data, pe + 6)
    optional = pe + 24
    directory = optional + (112 if struct.unpack_from("<H", data, optional)[0] == 0x20B else 96)
    import_rva = struct.unpack_from("<I", data, directory + 8)[0]
    sections = [struct.unpack_from("<8xIIII", data, optional + optional_size + i * 40)
                for i in range(section_count)]

    def offset(rva):
        for virtual_size, address, raw_size, raw in sections:
            if address <= rva < address + max(virtual_size, raw_size):
                return raw + rva - address
        raise ValueError(f"unmapped RVA {rva}")

    def string(rva):
        start = offset(rva)
        return data[start:data.index(b"\0", start)].decode("ascii")

    descriptor = offset(import_rva)
    while True:
        thunk, _, _, name, first = struct.unpack_from("<IIIII", data, descriptor)
        if not name:
            break
        entries = offset(thunk or first)
        symbols = []
        while value := struct.unpack_from("<Q", data, entries)[0]:
            symbols.append(value & 0xFFFF if value & (1 << 63) else string(value + 2))
            entries += 8
        yield string(name), symbols
        descriptor += 20


def main():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LoadLibraryExW.argtypes = [ctypes.c_wchar_p, ctypes.c_void_p, ctypes.c_uint]
    kernel.LoadLibraryExW.restype = ctypes.c_void_p
    kernel.GetProcAddress.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel.GetProcAddress.restype = ctypes.c_void_p
    missing = 0
    for dll, symbols in imports(sys.argv[1]):
        handle = kernel.LoadLibraryExW(dll, None, 1)
        if not handle:
            print(f"CANNOT LOAD {dll}: {ctypes.get_last_error()}")
            continue
        for symbol in symbols:
            key = ctypes.c_void_p(symbol) if isinstance(symbol, int) else ctypes.cast(ctypes.c_char_p(symbol.encode()), ctypes.c_void_p)
            if not kernel.GetProcAddress(handle, key):
                print(f"MISSING EXPORT {dll}!{symbol}")
                missing += 1
        print(f"Inspected {dll}: {len(symbols)} imports")
    print(f"Missing direct exports: {missing}")
    return bool(missing)


if __name__ == "__main__":
    sys.exit(main())
