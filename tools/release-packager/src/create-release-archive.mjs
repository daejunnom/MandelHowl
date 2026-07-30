import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  lstat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(process.cwd());
const outputRoot = path.join(projectRoot, "outputs");
const archivePath = path.join(outputRoot, "mandelhowl-release.zip");
const inventoryPath = path.join(outputRoot, "mandelhowl-release.json");
const fixedDosDate = (1 << 5) | 1; // 1980-01-01

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value =
      value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function collectFiles(relativePath, result) {
  const absolutePath = path.join(projectRoot, relativePath);
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Release archive entry must not be a symlink: ${relativePath}`);
  }
  if (metadata.isFile()) {
    result.push(relativePath.replaceAll(path.sep, "/"));
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Unsupported release entry: ${relativePath}`);
  }
  const entries = await readdir(absolutePath);
  entries.sort((left, right) => left.localeCompare(right, "en"));
  for (const entry of entries) {
    await collectFiles(path.join(relativePath, entry), result);
  }
}

function localHeader(nameBytes, bytes, checksum) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(fixedDosDate, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(bytes.length, 18);
  header.writeUInt32LE(bytes.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(nameBytes, bytes, checksum, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(fixedDosDate, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(bytes.length, 20);
  header.writeUInt32LE(bytes.length, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

async function buildArchive() {
  const files = [];
  for (const entry of [
    "dist",
    "public",
    "release/dataset-lock.json",
    "release/third-party-license-inventory.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ]) {
    await collectFiles(entry, files);
  }
  files.sort((left, right) => left.localeCompare(right, "en"));

  const localParts = [];
  const centralParts = [];
  const inventory = [];
  let offset = 0;
  for (const file of files) {
    const bytes = await readFile(path.join(projectRoot, file));
    const nameBytes = Buffer.from(file, "utf8");
    const checksum = crc32(bytes);
    const header = localHeader(nameBytes, bytes, checksum);
    localParts.push(header, nameBytes, bytes);
    centralParts.push(
      centralHeader(nameBytes, bytes, checksum, offset),
      nameBytes,
    );
    offset += header.length + nameBytes.length + bytes.length;
    inventory.push({
      path: file,
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  const archive = Buffer.concat([...localParts, centralBytes, end]);
  return { archive, inventory };
}

const { archive, inventory } = await buildArchive();
const archiveSha256 = createHash("sha256")
  .update(archive)
  .digest("hex");
const descriptor = `${JSON.stringify(
  {
    schemaVersion: "mandelhowl.release-archive.v1",
    archive: path.basename(archivePath),
    sha256: archiveSha256,
    byteLength: archive.length,
    entries: inventory,
  },
  null,
  2,
)}\n`;

if (process.argv.includes("--check")) {
  const [existingArchive, existingInventory] = await Promise.all([
    readFile(archivePath),
    readFile(inventoryPath, "utf8"),
  ]);
  if (!existingArchive.equals(archive) || existingInventory !== descriptor) {
    throw new Error("Release archive is not reproducible.");
  }
  process.stdout.write(
    `Reproduced ${archiveSha256} from ${inventory.length} files.\n`,
  );
} else {
  await mkdir(outputRoot, { recursive: true });
  await Promise.all([
    writeFile(archivePath, archive),
    writeFile(inventoryPath, descriptor, "utf8"),
  ]);
  process.stdout.write(
    `Wrote ${archivePath} (${archiveSha256}, ${inventory.length} files).\n`,
  );
}
