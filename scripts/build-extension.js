const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dist", "extension");

const crcTable = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
};

const solidPng = (size) => {
  const row = Buffer.alloc(1 + size * 4);
  for (let x = 0; x < size; x++) {
    row[1 + x * 4] = 14;
    row[2 + x * 4] = 116;
    row[3 + x * 4] = 144;
    row[4 + x * 4] = 255;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const rel = (file) => path.relative(ROOT, file).split(path.sep).join("/");

const resolveReq = (fromFile, spec) => {
  if (!spec.startsWith(".")) throw new Error(`Only relative modules can be bundled: ${spec}`);
  let abs = path.resolve(path.dirname(fromFile), spec);
  if (!abs.endsWith(".js")) abs += ".js";
  return abs;
};

const collect = (entry) => {
  const order = [];
  const seen = new Set();
  const visit = (file) => {
    const abs = path.resolve(file);
    if (seen.has(abs)) return;
    seen.add(abs);
    const code = fs.readFileSync(abs, "utf8");
    const deps = [];
    for (const match of code.matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      deps.push(resolveReq(abs, match[1]));
    }
    for (const dep of deps) visit(dep);
    order.push(abs);
  };
  visit(entry);
  return order;
};

const bundle = (entry) => {
  const files = collect(entry);
  let out =
    "(function(){\nconst __m={};\nfunction __req(id){\n" +
    "if(!__m[id].exp){const module={exports:{}};__m[id].fn(module,module.exports,__req);__m[id].exp=module.exports;}\n" +
    "return __m[id].exp;\n}\n";
  for (const file of files) {
    const code = fs
      .readFileSync(file, "utf8")
      .replace(/require\(\s*["'](\.[^"']+)["']\s*\)/g, (_, spec) => {
        return `__req(${JSON.stringify(rel(resolveReq(file, spec)))})`;
      });
    if (/require\(\s*["'][^.]/.test(code)) {
      throw new Error(`External require left in ${rel(file)}`);
    }
    out += `__m[${JSON.stringify(rel(file))}]= {fn:function(module,exports,require){\n${code}\n}};\n`;
  }
  out += `__req(${JSON.stringify(rel(path.resolve(entry)))});\n})();\n`;
  return out;
};

const buildExtension = () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "icons"), { recursive: true });
  const copy = (name) => fs.copyFileSync(path.join(ROOT, "extension", name), path.join(OUT, name));
  copy("manifest.json");
  copy("popup.html");
  copy("popup.css");
  copy("options.html");
  copy("options.css");
  fs.writeFileSync(path.join(OUT, "background.js"), bundle(path.join(ROOT, "extension", "src", "background.js")));
  fs.writeFileSync(path.join(OUT, "content.js"), bundle(path.join(ROOT, "extension", "src", "content.js")));
  fs.writeFileSync(path.join(OUT, "popup.js"), bundle(path.join(ROOT, "extension", "src", "popup.js")));
  fs.writeFileSync(path.join(OUT, "options.js"), bundle(path.join(ROOT, "extension", "src", "options.js")));
  fs.writeFileSync(path.join(OUT, "icons", "icon16.png"), solidPng(16));
  fs.writeFileSync(path.join(OUT, "icons", "icon48.png"), solidPng(48));
  fs.writeFileSync(path.join(OUT, "icons", "icon128.png"), solidPng(128));
  return OUT;
};

if (require.main === module) {
  const dir = buildExtension();
  process.stdout.write(`${dir}\n`);
}

module.exports = { buildExtension, bundle };
