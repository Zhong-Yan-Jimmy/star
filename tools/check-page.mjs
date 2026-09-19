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
  /* 天体个数只查个大概：以后加一颗小行星或矮行星是好改动，不该让脚本变红。
     上界是后加的——恒星那份列表有 142 项，光看「> 10」它也满足，
     这个断言就失去区分度了。页面刚加载时必然是太阳系那份 */
  ok(info.planets > 10 && info.planets < 60,
     '左边那份天体索引还在（是太阳系那份，不是恒星那份）', info.planets + ' 个');
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

  /* ---- 地球档案里那条去 TERRA 的路 ----
     按 dataset.id 找而不是按下标：列表里有没有太阳、卫星排在第几位，都是
     别处决定的事，下标会跟着它们一起漂 */
  const clickBody = id => page.evaluate(want => {
    const rows = document.querySelectorAll('.planet-list .p-item');
    const el = Array.prototype.filter.call(rows, r => r.dataset.id === want)[0];
    if (el) el.click();
    return !!el;
  }, id);

  ok(await clickBody('earth'), '天体索引里有地球这一项');
  await sleep(1000);
  const ext = await page.evaluate(() => {
    const a = document.querySelector('#info-body a.info-action-ext');
    if (!a) return null;
    return {
      href: a.getAttribute('href'),
      target: a.getAttribute('target'),
      rel: a.getAttribute('rel'),
      text: a.textContent.trim(),
      h: Math.round(a.getBoundingClientRect().height),
    };
  });
  ok(!!ext, '点地球，档案里多出去 TERRA 的入口',
     ext ? ext.text : '（没找到 a.info-action-ext）');
  if (ext) {
    ok(ext.href === '../terra/index.html', 'href 指向 TERRA', ext.href);
    ok(ext.target === '_blank', '新标签页打开', ext.target);
    ok(/noopener/.test(ext.rel || ''), 'rel 带 noopener（否则 TERRA 能反向操作这一页）', ext.rel);
    /* 光看 DOM 里有没有还不够：样式写歪了它也会在，只是看不见 */
    ok(ext.h > 20, '按钮有实际高度，没有被压扁', ext.h + 'px');
  }

  /* 反向那半条才是关键：只断言「地球有」的话，把判断写成恒真也能过 */
  await clickBody('venus');
  await sleep(1000);
  const onVenus = await page.evaluate(() =>
    !!document.querySelector('#info-body a.info-action-ext'));
  ok(!onVenus, '换回金星，入口不出现——只对地球有');

  /* ---- 邻近恒星 · 数据层 ----
     从 __solaris.stars 读而不是 window.NEARBY_STARS：data.js 里写的是
     const，而顶层的 const 只进全局词法环境、不会变成 window 的属性
     （只有 var 会），直接读 window 会拿到 undefined。
     这类断言在这里跑比在 node 里跑更有意义：走的正是浏览器真正执行的那份 */
  const starData = await page.evaluate(() => {
    const S = window.__solaris && window.__solaris.stars;
    if (!S) return null;
    return {
      n: S.length,
      schema: S.every(s => s.id && s.name && s.en && s.type && s.badge &&
        Array.isArray(s.facts) && s.facts.length === 6 &&
        s.facts.every(f => f.length === 2 && f[0] && f[1]) &&
        typeof s.desc === 'string' && s.desc.length > 10 &&
        typeof s.ra === 'number' && typeof s.dec === 'number' &&
        typeof s.dist === 'number' && typeof s.color === 'number'),
      ids: new Set(S.map(s => s.id)).size === S.length,
      ranges: S.every(s => s.ra >= 0 && s.ra < 24 && s.dec >= -90 && s.dec <= 90 &&
                           s.dist >= 4 && s.dist <= 100),
      sorted: S.every((s, i) => i === 0 || S[i - 1].dist <= s.dist),
    };
  });
  ok(!!starData, '恒星数据挂上了全局');
  if (starData) {
    ok(starData.n >= 140 && starData.n <= 170, '恒星条数在预期区间', starData.n + ' 条');
    ok(starData.schema, '每条都有 id/name/type/badge/六条 facts/desc/坐标/颜色');
    ok(starData.ids, 'id 不重复');
    ok(starData.ranges, 'ra∈[0,24) dec∈[-90,90] dist∈[4,100]——提取时最容易错的三处');
    ok(starData.sorted, '按距离升序（列表点击绑定靠下标，顺序是契约的一部分）');
  }

  /* ---- 模式切换 ---- */
  await page.waitForFunction(() => window.__solaris && window.__solaris.state.booted,
                             { timeout: 25000 });

  const before = await page.evaluate(() => {
    const A = window.__solaris;
    return {
      planets: A.planets.length,
      picks: A.activePickables().length,
      rows: document.querySelectorAll('.planet-list .p-item').length,
    };
  });

  /* 点真的按钮，不是直接调 switchMode：要测的就是用户会做的那一下 ——
     顺带也测了「这个按钮没被别的东西盖住」。上一段刚点过金星，右侧那份
     410px 宽的档案浮层正开着，不先收起来它正好压在控制台上 */
  await page.keyboard.press('Escape');
  await sleep(700);
  await page.click('#btn-mode');
  await sleep(2300);
  const inStar = await page.evaluate(() => {
    const A = window.__solaris;
    const rows = document.querySelectorAll('.planet-list .p-item');
    return {
      mode: A.state.mode, switching: A.state.switching,
      solar: A.worldSolar.visible, star: A.worldStars.visible,
      min: A.controls.minDistance, max: A.controls.maxDistance,
      btn: document.querySelector('#btn-mode').textContent.trim(),
      credit: !document.querySelector('#list-credit').hidden,
      picks: A.activePickables().length,
      refs: A.starRefs.length,
      rows: rows.length,
      firstId: rows[0] ? rows[0].dataset.id : '',
      label: document.querySelector('#list-label span').textContent.trim(),
    };
  });
  ok(inStar.mode === 'star' && !inStar.switching, '点模式按钮切到恒星模式', inStar.mode);
  ok(!inStar.solar && inStar.star, '太阳系藏起来、恒星世界露面（靠 visible，不是 add/remove）');
  ok(inStar.min === 3 && inStar.max === 400, '相机距离限制跟着换',
     inStar.min + ' / ' + inStar.max);
  ok(inStar.btn === '返回太阳系', '按钮文案变成回来的那一个', inStar.btn);
  ok(inStar.credit, 'HYG 的署名露出来了（CC BY-SA 4.0 的许可条件）');
  /* 拾取列表必须是真的换掉了 —— 藏起来的太阳系天体照样会被射线命中，
     这一条要是错，在恒星模式里点星野会点出木星的档案 */
  ok(inStar.picks === 142 && inStar.refs === 141,
     '拾取列表换成了恒星那份（141 颗星 + 太阳）',
     inStar.picks + ' 个目标 / ' + inStar.refs + ' 颗星');
  ok(inStar.rows === 142 && inStar.firstId === 'sun',
     '左栏换成恒星列表，太阳排第一行（距离都从它量起）',
     inStar.rows + ' 行，首行 ' + inStar.firstId);
  ok(/NEARBY/.test(inStar.label), '面板标签跟着换', inStar.label);

  /* ---- 方位是不是真的 ----
     这是整个功能唯一能自证的断言。别的断言只能证明「画面上有个东西」，
     这一条拿场景坐标反算回赤道坐标，跟天狼星 J2000 的外部权威值比 ——
     星座的相对形状对不对，全押在这一个换算上。
     天狼星 J2000：RA 06h45m08.9s = 6.7525h，Dec −16°42′58″ = −16.7161° */
  const sirius = await page.evaluate(() => {
    const A = window.__solaris;
    const i = A.stars.findIndex(s => s.id === 'sirius');
    if (i < 0) return null;
    const p = A.starRefs[i].anchor.position;
    const r = p.length();
    let ra = Math.atan2(-p.z, p.x) * 180 / Math.PI;
    if (ra < 0) ra += 360;
    return {
      ra: ra / 15,
      dec: Math.asin(p.y / r) * 180 / Math.PI,
      dist: Math.pow(r / A.STAR_SCALE, 1 / A.STAR_GAMMA),
    };
  });
  ok(sirius && Math.abs(sirius.ra - 6.7525) * 15 < 0.01 &&
              Math.abs(sirius.dec + 16.7161) < 0.01 &&
              Math.abs(sirius.dist - 8.60) < 0.02,
     '天狼星的方位与 J2000 对得上——星座方位是真的，不是随手摆的',
     sirius ? 'ra ' + sirius.ra.toFixed(4) + 'h / dec ' + sirius.dec.toFixed(4) +
              '° / ' + sirius.dist.toFixed(2) + ' ly' : '（数据里没有 sirius）');

  /* ---- 左栏点击 ----
     恒星列表刚被换过，而点击绑定靠的是 items[i] 与 querySelectorAll 的顺序
     一一对应 —— 这一条正是那个隐式契约的哨兵。点第 3 行，打开的必须就是
     第 3 行写的那颗，不是被下标串位串到的别人 */
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.planet-list .p-item');
    if (rows[2]) rows[2].click();
  });
  await sleep(1500);
  const starRow = await page.evaluate(() => {
    const rows = document.querySelectorAll('.planet-list .p-item');
    const el = document.querySelector('.is-open');
    return {
      want: rows[2] ? rows[2].querySelector('.p-name').textContent : '',
      got: el ? el.textContent.replace(/\s+/g, ' ').trim() : '',
      active: rows[2] ? rows[2].classList.contains('is-active') : false,
    };
  });
  ok(starRow.want && starRow.got.includes(starRow.want) && starRow.active,
     '点恒星列表第 3 行，打开的正是那一颗（下标绑定没串位）',
     starRow.want + ' → ' + (starRow.got.slice(0, 34) || '（没打开）'));

  await page.keyboard.press('Escape');
  await sleep(500);
  await page.click('#btn-mode');
  await sleep(2300);
  const back = await page.evaluate(() => {
    const A = window.__solaris;
    return {
      mode: A.state.mode, planets: A.planets.length,
      picks: A.activePickables().length,
      rows: document.querySelectorAll('.planet-list .p-item').length,
      max: A.controls.maxDistance,
    };
  });
  ok(back.mode === 'solar' && back.planets === before.planets,
     '切回来行星一个没少一个没多——证明是显隐而不是重建',
     before.planets + ' → ' + back.planets);
  ok(back.picks === before.picks && back.rows === before.rows,
     '拾取列表和左栏行数都还原了', before.picks + ' → ' + back.picks);
  ok(back.max === 620, '相机限制也还原了', back.max);

  /* 跨模式没有串味：在恒星那边点过星、换过列表、关过面板，切回来这套
     还得原样能用。地球档案里那条去 TERRA 的路是最合适的探针 —— 它上面
     压着三个月里所有改动的累积效果，坏了不会不声不响 */
  ok(await clickBody('earth'), '切回来还能从索引里点到地球');
  await sleep(1100);
  const extBack = await page.evaluate(() => {
    const a = document.querySelector('#info-body a.info-action-ext');
    return a ? a.getAttribute('href') : '';
  });
  ok(extBack === '../terra/index.html', 'TERRA 的入口还在（跨模式没把档案搞坏）',
     extBack || '（没了）');
  await page.keyboard.press('Escape');
  await sleep(500);

  /* 连点：switching 守卫要拦住后面的每一击，否则两段补间会抢同一个 camera */
  await page.evaluate(() => {
    const A = window.__solaris;
    A.switchMode('star'); A.switchMode('star'); A.switchMode('star');
  });
  await sleep(2300);
  const guarded = await page.evaluate(() => window.__solaris.state.mode);
  ok(guarded === 'star', '切换途中连点三下，只有第一下令出得去', guarded);

  await page.evaluate(() => window.__solaris.switchMode('solar'));
  await sleep(2300);

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
