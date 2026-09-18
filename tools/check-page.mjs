/* star 的页面检查。

   这个项目里没有可断言的业务逻辑——没有 e1RM、没有营养换算那种「算错了
   界面照样好看」的东西，所以能验的就是「页面还活着、还能点」：canvas 起没
   起来、天体索引在不在、点一个天体详情面板开不开、控制台干不干净。

   本地和线上各跑一遍不是重复劳动。file:// 下有一类错根本不会出现：favicon
   的 404 在本地不进控制台（它不是 HTTP 请求），挂到 Pages 上才变成一条红
   的——star 一直缺 favicon，就是这么发现的。两边跑同一段代码，差别就只剩
   协议这一个变量。

   puppeteer 是从 terra 借的（本机没装 Chrome，只有 Edge），所以换个机器就
   跑不了；它是给这台机器上的日常验证用的，不是能分发的工具。

   用法:
     node tools/check-page.mjs          验本地 index.html
     node tools/check-page.mjs --live   验 GitHub Pages 上那份
*/
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));   // star/tools
const ROOT = dirname(HERE);                             // star
const LIVE = 'https://zhong-yan-jimmy.github.io/star/';

const live = process.argv[2] === '--live';
const target = live ? LIVE : pathToFileURL(join(ROOT, 'index.html')).href;

const require = createRequire(pathToFileURL('C:/Users/28158/Desktop/code/terra/package.json').href);
const puppeteer = require('puppeteer-core');

const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = true;
const ok = (cond, msg, extra) => {
  if (!cond) pass = false;
  console.log('  ' + (cond ? '✓' : '✗') + ' ' + msg + (extra !== undefined ? '  → ' + extra : ''));
};

/* 不放行任何 flag：要测的就是用户真正会打开的那个环境。放行项会把真问题
   测没——terra 那 29 张全绿截图挡不住一个黑球，就是这么来的 */
const b = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: [], defaultViewport: { width: 1440, height: 950 },
});

try {
  const page = await b.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  page.on('requestfailed', r => problems.push('requestfailed: ' + r.url() + '  ' + (r.failure() || {}).errorText));

  console.log('\nstar · ' + (live ? '线上' : '本地 file://'));
  console.log('─'.repeat(58));

  await page.goto(target, { waitUntil: 'load', timeout: 60000 });
  /* 场景要时间才起得来：three.min.js 就有 592K，之后还要现算一遍纹理 */
  await sleep(6000);

  const info = await page.evaluate(() => {
    const cv = document.querySelector('canvas');
    let webgl = false;
    try {
      const c = document.createElement('canvas');
      webgl = !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch (e) { webgl = false; }
    return {
      title: document.title,
      canvas: !!cv,
      size: cv ? cv.width + '×' + cv.height : '',
      planets: document.querySelectorAll('.planet-list .p-item').length,
      scripts: document.querySelectorAll('script[src]').length,
      webgl,
    };
  });

  ok(/SOLARIS/.test(info.title), '标题是 SOLARIS', info.title);
  ok(info.canvas, 'canvas 起来了', info.size);
  ok(info.webgl, 'Edge 能跑 WebGL（headless 下走软件渲染）');
  /* 天体个数只查个大概：以后加一颗小行星或矮行星是好改动，不该让脚本变红 */
  ok(info.planets > 10, '左边那份天体索引还在', info.planets + ' 个');
  ok(info.scripts >= 12, '十几个 script 都挂上了（少一个就少一块功能）', info.scripts + ' 个');

  /* 点一个天体。详情面板是 openInfo 给 .info 加 is-open 的那个浮层——
     .hud-left 是左边那份静态的天体索引，查它会误以为「点了没反应」 */
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.planet-list .p-item');
    if (rows[2]) rows[2].click();
  });
  await sleep(1500);
  const panel = await page.evaluate(() => {
    const el = document.querySelector('.is-open');
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  });
  ok(!!panel, '点第三个天体，详情面板打开了',
     panel ? panel.slice(0, 56) + '…' : '（页面上没有 .is-open）');

  console.log('\n控制台');
  console.log('─'.repeat(58));
  const real = [...new Set(problems)];
  if (!real.length) console.log('  ✓ 零报错、零失败请求');
  else { pass = false; real.forEach(p => console.log('  ✗ ' + p)); }

  console.log('\n' + (pass ? 'star · ' + (live ? '线上' : '本地') + ' 检查通过 ✓'
                            : 'star · ' + (live ? '线上' : '本地') + ' 检查有问题 ✗') + '\n');
  process.exitCode = pass ? 0 : 1;
} finally {
  await b.close();
}
