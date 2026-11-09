import fs from 'node:fs';
import path from 'node:path';
// The installed host exposes no api.storage. Keep only this plugin's state,
// with explicit permissions and atomic writes; never fall back to memory silently.
export function createFileStorage(dataDir) {
  const dir = path.join(dataDir, 'extension-state');
  const file = path.join(dir, 'bili-browse.json');
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch(e) { if (e.code === 'ENOENT') return {}; throw new Error('B站插件状态文件读取失败'); }
  };
  return {
    get(key) { return read()[key]; },
    set(key, value) {
      const data = read(); data[key] = value;
      fs.mkdirSync(dir, {recursive:true, mode:0o700});
      const temp = file + '.' + process.pid + '.tmp';
      try {
        fs.writeFileSync(temp, JSON.stringify(data), {encoding:'utf8',mode:0o600});
        fs.chmodSync(temp,0o600); fs.renameSync(temp,file);fs.chmodSync(file,0o600);
      } catch { try { fs.unlinkSync(temp); } catch {} throw new Error('B站插件状态保存失败'); }
    }
  };
}
