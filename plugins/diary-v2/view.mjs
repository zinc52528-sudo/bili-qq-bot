import {Diary} from './core.js';
import path from 'node:path';
const [dir,chat,...flags]=process.argv.slice(2);if(!dir||!chat){console.error('用法：node view.mjs <diary-v2数据目录> <group:群号或private:QQ号> [--full]');process.exit(1);}
const d=new Diary(path.resolve(dir)),v=d.load(chat),full=flags.includes('--full');
for(const [name,filter] of [['有效',e=>!e.deletedAt&&!e.shelf&&d.remaining(e)>0],['搁着',e=>!e.deletedAt&&!!e.shelf],['到期待决定',e=>!e.deletedAt&&!e.shelf&&d.remaining(e)<=0],['回收站',e=>!!e.deletedAt]]){console.log('\n【'+name+'】');for(const e of v.items.filter(filter))console.log(JSON.stringify(full?e:d.visible(e),null,2));}
