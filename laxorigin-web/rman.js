(function initRman(global) {
  "use strict";

  var textDecoder = new TextDecoder("utf-8");
  var externalZstdPromise = null;

  class ManifestError extends Error {
    constructor(code, message, cause) {
      super(message);
      this.name = "ManifestError";
      this.code = code;
      if (cause) this.cause = cause;
    }
  }

  class FlatBufferReader {
    constructor(bytes) {
      this.bytes = toUint8Array(bytes);
      this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    }

    u8(offset) {
      this.bounds(offset, 1);
      return this.view.getUint8(offset);
    }

    u16(offset) {
      this.bounds(offset, 2);
      return this.view.getUint16(offset, true);
    }

    u32(offset) {
      this.bounds(offset, 4);
      return this.view.getUint32(offset, true);
    }

    i32(offset) {
      this.bounds(offset, 4);
      return this.view.getInt32(offset, true);
    }

    u64(offset) {
      this.bounds(offset, 8);
      return this.view.getBigUint64(offset, true);
    }

    i64(offset) {
      this.bounds(offset, 8);
      return this.view.getBigInt64(offset, true);
    }

    rootTable() {
      return this.u32(0);
    }

    tableField(table, vtableOffset) {
      this.bounds(table, 4);
      var vtable = table - this.i32(table);
      this.bounds(vtable, 4);
      var vtableLength = this.u16(vtable);
      if (vtableOffset >= vtableLength) return 0;
      return this.u16(vtable + vtableOffset);
    }

    scalar(table, vtableOffset, read, defaultValue) {
      var field = this.tableField(table, vtableOffset);
      return field === 0 ? defaultValue : read.call(this, table + field);
    }

    uoffset(position) {
      return position + this.u32(position);
    }

    string(table, vtableOffset) {
      var field = this.tableField(table, vtableOffset);
      if (field === 0) return "";
      var start = this.uoffset(table + field);
      var length = this.u32(start);
      var dataStart = start + 4;
      this.bounds(dataStart, length);
      return textDecoder.decode(this.bytes.subarray(dataStart, dataStart + length));
    }

    vector(table, vtableOffset, itemSize, readItem) {
      var field = this.tableField(table, vtableOffset);
      if (field === 0) return [];
      var vector = this.uoffset(table + field);
      var length = this.u32(vector);
      var dataStart = vector + 4;
      var items = [];

      for (var i = 0; i < length; i += 1) {
        items.push(readItem.call(this, dataStart + i * itemSize));
      }

      return items;
    }

    tableVector(table, vtableOffset, readTable) {
      return this.vector(table, vtableOffset, 4, function read(position) {
        return readTable.call(this, this.uoffset(position));
      });
    }

    bounds(offset, length) {
      if (offset < 0 || offset + length > this.bytes.length) {
        throw new ManifestError(
          "FlatbufferError",
          "flatbuffer read out of bounds at " + offset + " (" + length + " bytes)",
        );
      }
    }
  }

  function toUint8Array(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (ArrayBuffer.isView(bytes)) {
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    throw new TypeError("expected an ArrayBuffer, Uint8Array, or typed array view");
  }

  function concatUint8Arrays(parts) {
    var length = 0;
    for (var i = 0; i < parts.length; i += 1) length += parts[i].length;

    var out = new Uint8Array(length);
    var offset = 0;
    for (var j = 0; j < parts.length; j += 1) {
      out.set(parts[j], offset);
      offset += parts[j].length;
    }

    return out;
  }

  function parseHeader(bytes) {
    var data = toUint8Array(bytes);
    var view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    if (data.length < 28) {
      throw new ManifestError("IoError", "unexpected EOF while reading RMAN header");
    }

    var magic = view.getUint32(0, true);
    if (magic !== 0x4e414d52) {
      throw new ManifestError(
        "InvalidMagicBytes",
        'invalid magic bytes (expected: "0x4E414D52", was: "0x' +
          magic.toString(16).padStart(8, "0") +
          '")',
      );
    }

    var header = {
      magic: magic,
      major: view.getUint8(4),
      minor: view.getUint8(5),
      flags: view.getUint16(6, true),
      offset: view.getUint32(8, true),
      compressedSize: view.getUint32(12, true),
      manifestId: view.getBigUint64(16, true),
      uncompressedSize: view.getUint32(24, true),
    };

    if (header.offset < 28 || header.offset >= data.length) {
      throw new ManifestError("InvalidOffset", "offset (" + header.offset + ") is larger than the total file size");
    }

    if (header.compressedSize > data.length - 28 || header.compressedSize + header.offset > data.length) {
      throw new ManifestError(
        "CompressedSizeTooLarge",
        "compressed size (" + header.compressedSize + ") is larger than the total file size",
      );
    }

    return header;
  }

  function parseManifestData(bytes) {
    var reader = new FlatBufferReader(bytes);
    var root = reader.rootTable();

    var bundleEntries = reader.tableVector(root, 4, function parseBundle(table) {
      return {
        id: this.scalar(table, 4, this.i64, 0n),
        chunks: this.tableVector(table, 6, parseChunk),
      };
    });

    var tagEntries = reader.tableVector(root, 6, function parseTag(table) {
      return {
        id: this.scalar(table, 4, this.u8, 0),
        name: this.string(table, 6),
      };
    });

    var fileEntries = reader.tableVector(root, 8, function parseFile(table) {
      return {
        id: this.scalar(table, 4, this.i64, 0n),
        directoryId: this.scalar(table, 6, this.i64, 0n),
        size: this.scalar(table, 8, this.u32, 0),
        name: this.string(table, 10),
        tagBitmask: this.scalar(table, 12, this.u64, 0n),
        unk5: this.scalar(table, 14, this.u8, 0),
        unk6: this.scalar(table, 16, this.u8, 0),
        chunkIds: this.vector(table, 18, 8, this.i64),
        unk8: this.scalar(table, 20, this.u8, 0),
        symlink: this.string(table, 22),
        unk10: this.scalar(table, 24, this.u16, 0),
        chunkingParamId: this.scalar(table, 26, this.u8, 0),
        permissions: this.scalar(table, 28, this.u8, 0),
      };
    });

    var directoryEntries = reader.tableVector(root, 10, function parseDirectory(table) {
      return {
        id: this.scalar(table, 4, this.i64, 0n),
        parentId: this.scalar(table, 6, this.i64, 0n),
        name: this.string(table, 8),
      };
    });

    var keyEntries = reader.tableVector(root, 12, function parseKey(table) {
      return {
        unk0: this.scalar(table, 4, this.u16, 0),
        unk1: this.scalar(table, 6, this.u32, 0),
      };
    });

    var chunkingParamEntries = reader.tableVector(root, 14, function parseChunkingParam(table) {
      return {
        unk0: this.scalar(table, 4, this.u16, 0),
        chunkingVersion: this.scalar(table, 6, this.u8, 0),
        minChunkSize: this.scalar(table, 8, this.u32, 0),
        chunkSize: this.scalar(table, 10, this.u32, 0),
        maxChunkSize: this.scalar(table, 12, this.u32, 0),
      };
    });

    return {
      bundleEntries: bundleEntries,
      directoryEntries: directoryEntries,
      fileEntries: fileEntries,
      keyEntries: keyEntries,
      tagEntries: tagEntries,
      chunkingParamEntries: chunkingParamEntries,
      files: buildFiles(fileEntries, tagEntries, directoryEntries, bundleEntries),
    };
  }

  function parseChunk(table) {
    return {
      id: this.scalar(table, 4, this.i64, 0n),
      compressedSize: this.scalar(table, 6, this.u32, 0),
      uncompressedSize: this.scalar(table, 8, this.u32, 0),
    };
  }

  function buildFiles(fileEntries, tagEntries, directoryEntries, bundleEntries) {
    var tags = new Map(tagEntries.map(function mapTag(tag) {
      return [tag.id, tag.name];
    }));
    var directories = new Map(directoryEntries.map(function mapDirectory(dir) {
      return [dir.id.toString(), dir];
    }));
    var chunks = new Map();

    for (var i = 0; i < bundleEntries.length; i += 1) {
      var bundle = bundleEntries[i];
      var offset = 0;
      for (var j = 0; j < bundle.chunks.length; j += 1) {
        var chunk = bundle.chunks[j];
        chunks.set(chunk.id.toString(), {
          bundleId: bundle.id,
          offset: offset,
          uncompressedSize: chunk.uncompressedSize,
          compressedSize: chunk.compressedSize,
        });
        offset += chunk.compressedSize;
      }
    }

    return fileEntries.map(function mapFile(file) {
      var directoryId = file.directoryId;
      var path = "";

      while (directoryId !== 0n) {
        var directory = directories.get(directoryId.toString());
        if (!directory) {
          throw new ManifestError(
            "FileParseError",
            'could not find a directory with the following id: "' + directoryId + '"',
          );
        }
        path = directory.name + "/" + path;
        directoryId = directory.parentId;
      }

      var fileTags = [];
      for (var bit = 0; bit < 64; bit += 1) {
        if ((file.tagBitmask & (1n << BigInt(bit))) === 0n) continue;
        var tagName = tags.get(bit + 1);
        if (tagName) fileTags.push(tagName);
      }

      var fileChunks = file.chunkIds.map(function mapChunkId(chunkId) {
        var fileChunk = chunks.get(chunkId.toString());
        if (!fileChunk) {
          throw new ManifestError(
            "FileParseError",
            'could not find a chunk with the following id: "' + chunkId + '"',
          );
        }
        return fileChunk;
      });

      return {
        id: file.id,
        name: file.name,
        permissions: file.permissions,
        size: file.size,
        path: path + file.name,
        symlink: file.symlink,
        tags: fileTags,
        chunks: fileChunks,
        download: function download(bundleUrl, options) {
          return downloadFile({ chunks: fileChunks }, bundleUrl, options);
        },
      };
    });
  }

  async function decompressZstd(bytes, options) {
    var input = toUint8Array(bytes);
    var opts = options || {};

    if (typeof opts.decompressZstd === "function") {
      return toUint8Array(await opts.decompressZstd(input, opts.expectedSize));
    }

    if (typeof global.DecompressionStream === "function") {
      try {
        var stream = new Blob([input]).stream().pipeThrough(new global.DecompressionStream("zstd"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (error) {
        var nativeError = error;
        try {
          var fallback = await loadExternalZstd();
          return toUint8Array(await fallback(input, opts));
        } catch (fallbackError) {
          throw new ManifestError(
            "ZstdDecompressError",
            "zstd decompression failed. Native browser zstd failed (" +
              nativeError.message +
              ") and CDN fallback failed (" +
              fallbackError.message +
              ").",
            fallbackError,
          );
        }
      }
    }

    try {
      var fallbackDecoder = await loadExternalZstd();
      return toUint8Array(await fallbackDecoder(input, opts));
    } catch (error) {
      throw new ManifestError(
        "ZstdDecompressError",
        'this browser does not support DecompressionStream("zstd"), and the CDN zstd fallback could not be loaded: ' +
          error.message,
        error,
      );
    }
  }

  async function loadExternalZstd() {
    if (!externalZstdPromise) {
      externalZstdPromise = (async function load() {
        if (global.fzstd && typeof global.fzstd.decompress === "function") {
          return function decodeWithGlobalFzstd(bytes) {
            return global.fzstd.decompress(bytes);
          };
        }

        try {
          var fzstd = await import("https://cdn.jsdelivr.net/npm/fzstd/+esm");
          var decompress = fzstd.decompress || fzstd.default && fzstd.default.decompress;
          if (typeof decompress === "function") {
            return function decodeWithFzstd(bytes) {
              return decompress(bytes);
            };
          }
        } catch (_) {
          // Try the WASM decoder below.
        }

        var zstddec = await import("https://esm.sh/zstddec");
        var Decoder = zstddec.ZSTDDecoder || zstddec.default && zstddec.default.ZSTDDecoder;
        if (!Decoder) throw new Error("zstddec did not export ZSTDDecoder");

        var decoder = new Decoder();
        if (typeof decoder.init === "function") await decoder.init();

        return function decodeWithZstddec(bytes, decodeOptions) {
          if (typeof decoder.decode === "function") {
            return decoder.decode(bytes, decodeOptions && decodeOptions.expectedSize);
          }
          if (typeof decoder.decompress === "function") {
            return decoder.decompress(bytes, decodeOptions && decodeOptions.expectedSize);
          }
          throw new Error("zstddec decoder has no decode/decompress method");
        };
      })();
    }

    return externalZstdPromise;
  }

  async function parse(buffer, options) {
    var bytes = toUint8Array(buffer);
    var header = parseHeader(bytes);
    var compressed = bytes.subarray(header.offset, header.offset + header.compressedSize);
    var decompressed = await decompressZstd(compressed, Object.assign({}, options, {
      expectedSize: header.uncompressedSize,
    }));

    if (decompressed.length !== header.uncompressedSize) {
      throw new ManifestError(
        "ZstdDecompressError",
        "decompressed size mismatch (expected " +
          header.uncompressedSize +
          ", got " +
          decompressed.length +
          ")",
      );
    }

    return {
      header: header,
      data: parseManifestData(decompressed),
    };
  }

  async function fromFile(file, options) {
    return parse(await file.arrayBuffer(), options);
  }

  async function fromUrl(url, options) {
    var response = await fetch(url, options && options.fetch);
    if (!response.ok) {
      throw new ManifestError("ReqwestError", "manifest request failed with HTTP " + response.status);
    }
    return parse(await response.arrayBuffer(), options);
  }

  async function downloadFile(file, bundleUrl, options) {
    var opts = options || {};
    var parts = [];
    var base = String(bundleUrl).replace(/\/+$/, "");

    for (var i = 0; i < file.chunks.length; i += 1) {
      var chunk = file.chunks[i];
      var from = chunk.offset;
      var to = chunk.offset + chunk.compressedSize - 1;
      var bundleId = BigInt.asUintN(64, chunk.bundleId).toString(16).toUpperCase().padStart(16, "0");
      var response = await fetch(base + "/" + bundleId + ".bundle", {
        headers: { Range: "bytes=" + from + "-" + to },
      });

      if (!response.ok && response.status !== 206) {
        throw new ManifestError("ReqwestError", "bundle request failed with HTTP " + response.status);
      }

      var compressed = new Uint8Array(await response.arrayBuffer());
      var decompressed = await decompressZstd(compressed, Object.assign({}, opts, {
        expectedSize: chunk.uncompressedSize,
      }));
      if (decompressed.length !== chunk.uncompressedSize) {
        throw new ManifestError(
          "ZstdDecompressError",
          "chunk decompressed size mismatch (expected " +
            chunk.uncompressedSize +
            ", got " +
            decompressed.length +
            ")",
        );
      }
      parts.push(decompressed);
    }

    return concatUint8Arrays(parts);
  }

  var api = {
    ManifestError: ManifestError,
    parse: parse,
    fromFile: fromFile,
    fromUrl: fromUrl,
    parseHeader: parseHeader,
    parseManifestData: parseManifestData,
    decompressZstd: decompressZstd,
    downloadFile: downloadFile,
  };

  global.RMAN = api;

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);