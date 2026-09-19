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
  ok(info.scripts >= 13, '十几个 script 都挂上了（少一个就少一块功能）', info.scripts + ' 个');

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
      showOrbits: A.state.showOrbits,
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
  /* 280 不是随手取的：天球壳半径 300，壳星和线都是 depthWrite: false，
     没有东西遮挡远半球。相机一过 300 就看着前后两层星叠在一起，同一个
     星座两个副本 —— 而画面上只会觉得「星变密了」。这条守的是那个上界。 */
  ok(inStar.min === 3 && inStar.max === 280,
     '相机距离限制跟着换，而且上限压在壳半径 300 以内',
     inStar.min + ' / ' + inStar.max + '（壳半径 300）');
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

  /* ---- 天球壳 ----
     这一段全是「加法」的验证：内层那 141 颗的显隐、拾取、列表一个字没动，
     壳是一整块新挂上去的。它自己能不能立住，看下面这几条。 */
  const sky = await page.evaluate(() => {
    const A = window.__solaris;
    const g = A.skyGroup;
    const pts = g.children.filter(o => o.isPoints);
    const line = g.children.find(o => o.isLineSegments);

    let minR = Infinity, maxR = -Infinity, verts = 0;
    pts.forEach(p => {
      const a = p.geometry.attributes.position.array;
      for (let i = 0; i < a.length; i += 3) {
        const r = Math.hypot(a[i], a[i + 1], a[i + 2]);
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        verts++;
      }
    });

    const S = A.skyStars;
    const badField = S.filter(s => !(s.length === 5 && s[1] >= 0 && s[1] < 360 &&
      Math.abs(s[2]) <= 90 && isFinite(s[3]) && isFinite(s[4]))).length;

    let maxIdx = -1, segs = 0, degen = 0;
    Object.keys(A.skyLines).forEach(con => A.skyLines[con].forEach(l => {
      l.forEach(i => { if (i > maxIdx) maxIdx = i; });
      for (let i = 0; i < l.length - 1; i++) { segs++; if (l[i] === l[i + 1]) degen++; }
    }));

    // 线的头两个顶点，各自离最近的壳星有多远
    let onStar = Infinity;
    if (line) {
      const la = line.geometry.attributes.position.array;
      const v = new THREE.Vector3();
      for (let i = 0; i < 2; i++) {
        for (let k = 0; k < S.length; k++) {
          A.skyPositionOf(S[k][1], S[k][2], v);
          const d = Math.hypot(v.x - la[i * 3], v.y - la[i * 3 + 1], v.z - la[i * 3 + 2]);
          if (d < onStar) onStar = d;
        }
      }
    }

    const c = document.querySelector('#btn-constel');
    const o = document.querySelector('#btn-orbits');
    return {
      visible: g.visible, points: pts.length, verts,
      minR, maxR, starN: S.length, badField,
      cons: Object.keys(A.skyLines).length, segs, degen, maxIdx,
      lineVerts: line ? line.geometry.attributes.position.count : 0,
      onStar, picks: A.activePickables().length,
      conHidden: c ? c.hidden : true, conOn: c ? c.classList.contains('is-on') : false,
      orbHidden: o ? o.hidden : false, orbOn: o ? o.classList.contains('is-on') : false,
      note: !document.querySelector('#list-note').hidden,
    };
  });

  ok(sky.starN >= 1600 && sky.starN <= 1700, '壳星在预期条数', sky.starN + ' 颗');
  ok(sky.badField === 0,
     '每条都是 [HIP, ra°, dec°, mag, bv] 且 ra∈[0,360) dec∈[-90,90]',
     '（经度要从 -180..180 绕回来，这一步最容易漏）');
  ok(sky.points === 4 && sky.verts === sky.starN,
     '4 个星等桶装下了全部壳星，一个不多一个不少',
     sky.points + ' 个 Points / ' + sky.verts + ' 个顶点');
  ok(Math.abs(sky.minR - 300) < 0.01 && Math.abs(sky.maxR - 300) < 0.01,
     '全部壳星落在半径 300 的球面上——「壳」的本质',
     sky.minR.toFixed(3) + ' .. ' + sky.maxR.toFixed(3));
  ok(sky.cons === 88 && sky.degen === 0 && sky.lineVerts === sky.segs * 2,
     '88 个星座都连上了，没有退化的段，顶点数和段数对得上',
     sky.cons + ' 个星座 / ' + sky.segs + ' 段 / ' + sky.lineVerts + ' 顶点');
  ok(sky.maxIdx >= 0 && sky.maxIdx < sky.starN, '连线的下标不越界',
     '最大下标 ' + sky.maxIdx + ' < ' + sky.starN);
  ok(sky.onStar < 0.01,
     '线端落在壳星上——吸附真的生效了，线不会浮在空中', sky.onStar.toFixed(5));
  ok(sky.picks === 142,
     '壳层没混进拾取列表（1655 个壳星没有 data.radius，混进去会把相机算成 NaN）',
     sky.picks + ' 个目标');

  /* ---- 壳层方位：和上面天狼星那条同一个考法 ----
     壳和内层是两个独立的换算，都得自己证明自己对。这条要是错，
     星座线的形状会整体歪掉，但画面照样好看 */
  const siriusSky = await page.evaluate(() => {
    const A = window.__solaris;
    const s = A.skyStars.find(x => x[0] === 32349);   // HIP 32349 = 天狼星
    if (!s) return null;
    const v = new THREE.Vector3();
    A.skyPositionOf(s[1], s[2], v);
    const r = v.length();
    let ra = Math.atan2(-v.z, v.x) * 180 / Math.PI;
    if (ra < 0) ra += 360;
    return { ra, dec: Math.asin(v.y / r) * 180 / Math.PI, r };
  });
  ok(siriusSky && Math.abs(siriusSky.ra - 101.2872) < 0.01 &&
                   Math.abs(siriusSky.dec + 16.7161) < 0.01 &&
                   Math.abs(siriusSky.r - 300) < 0.001,
     '壳上天狼星的方位与 J2000 对得上——星座的形状是真的',
     siriusSky ? 'ra ' + siriusSky.ra.toFixed(4) + '° / dec ' +
                 siriusSky.dec.toFixed(4) + '° / r ' + siriusSky.r.toFixed(3) : '（没找到）');

  /* ---- 淡出：顶点色的结构 ----
     淡出是把系数写进顶点色（加法混合下「暗」就等于「透明」），所以属性得在
     构建期就建好填满。少建了属性不是「不生效」——GL 会把缺省的顶点属性读成
     (0,0,0)，整片线直接变黑。 */
  const fadeInfo = await page.evaluate(() => {
    const A = window.__solaris;
    const line = A.skyLineMesh;
    const col = line.geometry.attributes.color;
    const pos = line.geometry.attributes.position;

    /* 系数必须是灰度。顶点色里再烘一遍颜色的话会和 material.color 二次相乘，
       线上看着只是偏青，截图根本看不出来 */
    let notGray = 0;
    for (let i = 0; i < col.array.length; i += 3) {
      if (Math.abs(col.array[i] - col.array[i + 1]) > 1e-6 ||
          Math.abs(col.array[i] - col.array[i + 2]) > 1e-6) notGray++;
    }

    /* 每个星座的中心方向都得是单位向量（球面平均那步有没有忘掉 normalize），
       而且必须真的落在天球上那个星座附近 —— 只查长度的话，全部返回 (0,1,0)
       也能过。这里拿每个星座自己的成员星反查最近的一颗。 */
    const v = new THREE.Vector3();
    let badLen = 0, farCenter = 0;
    Object.keys(A.skyLines).forEach(con => {
      const item = A.skyConstellations.filter(c => c.name === A.skyConNames[con])[0];
      if (!item || Math.abs(item.dir.length() - 1) > 1e-6) { badLen++; return; }
      let best = 180;
      A.skyLines[con].forEach(line => line.forEach(si => {
        const s = A.skyStars[si];
        A.skyPositionOf(s[1], s[2], v);
        const ang = Math.acos(Math.min(Math.max(v.normalize().dot(item.dir), -1), 1))
                    * 180 / Math.PI;
        if (ang < best) best = ang;
      }));
      if (best > 30) farCenter++;
    });

    const ident = m => m.elements.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9);

    return {
      vc: line.material.vertexColors === true,
      itemSize: col.itemSize,
      colN: col.count, posN: pos.count, notGray,
      conN: A.skyConstellations.length,
      missing: Object.keys(A.skyLines).filter(k => !A.skyConNames[k]),
      badLen, farCenter,
      groupIdent: ident(A.skyGroup.matrix),
      worldIdent: ident(A.worldStars.matrix)
    };
  });

  ok(fadeInfo.vc && fadeInfo.itemSize === 3 && fadeInfo.colN === fadeInfo.posN,
     '线材质开着 vertexColors，顶点色和顶点一一对应（itemSize 必须是 3——4 会连带 alpha 一起乘）',
     'itemSize ' + fadeInfo.itemSize + ' / ' + fadeInfo.colN + ' 个顶点色');
  ok(fadeInfo.notGray === 0,
     '顶点色里只放灰度系数——放了颜色会和 material.color 二次相乘',
     fadeInfo.notGray === 0 ? '全部 r=g=b' : fadeInfo.notGray + ' 个顶点带了颜色');
  ok(fadeInfo.conN === 88 && fadeInfo.missing.length === 0,
     '88 个星座的中文名一个不缺（键用 IAU 三字母缩写，和 CONSTELLATION_LINES 同键）',
     fadeInfo.conN + ' 个星座' +
     (fadeInfo.missing.length ? '，缺 ' + fadeInfo.missing.join(',') : ''));
  ok(fadeInfo.badLen === 0 && fadeInfo.farCenter === 0,
     '88 个星座的中心是落在自己成员中间的单位向量——标签的位置就钉在它上面',
     fadeInfo.badLen ? fadeInfo.badLen + ' 个长度不对' :
       (fadeInfo.farCenter ? fadeInfo.farCenter + ' 个离成员超过 30°' : '全部合格'));
  ok(fadeInfo.groupIdent && fadeInfo.worldIdent,
     '壳层和恒星世界没有任何变换——淡出把顶点位置直接当世界方向用，这条是它的前提',
     'skyGroup / worldStars 都是单位矩阵');

  /* ---- 淡出和标签：都要动相机，在一个 evaluate 里做完再还原 ---- */
  const skyView = await page.evaluate(() => {
    const A = window.__solaris;
    const ori = A.skyConstellations.filter(c => c.name === '猎户座')[0];
    if (!ori) return { err: '没找到猎户座' };

    const sp = A.camera.position.clone();
    const sq = A.camera.quaternion.clone();
    /* 之后几帧 controls.update() 会从 camera.position 重算球坐标，所以还原
       位置就够了；但必须停掉它，否则它每帧把相机拽回原来的地方 */
    A.controls.enabled = false;

    /* 相机退到猎户座中心的反方向、壳内 105 处，看向原点 —— 也就是正对猎户座。
       105 是随便挑的：只要小于壳半径 300，中心在屏幕正中 */
    A.camera.position.copy(ori.dir).multiplyScalar(-105);
    A.camera.lookAt(0, 0, 0);
    /* 强制刷一次。正常路径上「相机位姿没变就跳过」，而这里刚改完，
       不强制的话读到的还是上一帧的系数 */
    A.skyUpdate();

    const col = A.skyLineMesh.geometry.attributes.color.array;
    let mx = -1, mn = 2;
    for (let i = 0; i < col.length; i += 3) {
      if (col[i] > mx) mx = col[i];
      if (col[i] < mn) mn = col[i];
    }

    const els = (A.skyLabelEls() || []).filter(e => !e.hidden);
    const w = window.innerWidth, h = window.innerHeight;
    const boxes = els.map(e => {
      const r = e.getBoundingClientRect();
      return { t: e.textContent, x: r.left, y: r.top, R: r.right, B: r.bottom };
    });
    const offscreen = boxes.filter(b =>
      b.x < -1 || b.y < -1 || b.R > w + 1 || b.B > h + 1).length;
    const shown = els.map(e => e.textContent);

    /* 面板是深色块，压在它们底下的名字只会露出半个字（「御夫座」变成
       「夫座」）。判据得和 updateSkyLayer 里的 blockedByPanel 一模一样：
       **整个名字的框**去和面板框相交（只看中心点的话，半个字伸进面板里
       照样过），面板清单也要含标题。 */
    const panels = ['.hud-left', '.hud-right', '.hud-title']
      .map(s => document.querySelector(s).getBoundingClientRect())
      .filter(r => r.width > 0 && r.height > 0);
    const underPanel = boxes.filter(b =>
      panels.some(p => b.x < p.right && b.R > p.left && b.y < p.bottom && b.B > p.top)
    ).length;

    A.camera.position.copy(sp);
    A.camera.quaternion.copy(sq);
    A.controls.enabled = true;
    A.skyUpdate();

    return { mx, mn, shown, offscreen, underPanel, n: boxes.length,
             floor: A.skyFade.floor, labelMax: A.skyFade.labelMax };
  });

  ok(!skyView.err && skyView.mx > 0.95 && skyView.mn < skyView.floor + 0.02,
     '淡出真的写进去了：屏幕正中满亮、边缘压到地板',
     skyView.err || skyView.mx.toFixed(3) + ' .. ' + skyView.mn.toFixed(3) +
                    '（地板 ' + skyView.floor + '）');
  ok(!skyView.err && skyView.n >= 1 && skyView.n <= skyView.labelMax,
     '正对猎户座时，露出来的名字在一到八个之间',
     skyView.err || skyView.shown.join('、') || '（一个都没有）');
  ok(!skyView.err && skyView.shown.length > 0 && skyView.shown.every(t => /座$/.test(t)),
     '每个名字都是以「座」收尾的星座名');
  ok(!skyView.err && skyView.shown.indexOf('猎户座') >= 0,
     '相机正对的那个星座，名字一定在——中心 → 屏幕坐标 → DOM 整条链是通的',
     skyView.err || (skyView.shown.indexOf('猎户座') >= 0
                     ? '猎户座在列' : '不在：' + skyView.shown.join('、')));
  ok(!skyView.err && skyView.offscreen === 0,
     '标签都落在视口里（那个 -50% 的居中位移不能把贴边的名字推出屏幕）',
     skyView.err || skyView.n + ' 个，越界 ' + skyView.offscreen);
  ok(!skyView.err && skyView.underPanel === 0,
     '没有名字压在左右两栏底下——那只会露出半个字，像坏了',
     skyView.err || skyView.n + ' 个，压住 ' + skyView.underPanel);

  /* ---- 相机退到壳外，淡出照样成立 ----
     这条专门守「判据用相对**相机**的方向，不是相对**原点**的方向」。

     相机停在与猎户座**同侧**的壳外（+380，壳半径才 300）：猎户座这时就在
     屏幕正中，但它在「原点方向」上是**反向**的。判据要是写成相对原点，
     屏幕中心会整片压到地板 —— 而画面上什么异常都看不出来，只是暗。

     （反侧 -380 那种排法抓不到这个错：两个判据在那儿恰好一致。） */
  const skyOutside = await page.evaluate(() => {
    const A = window.__solaris;
    const ori = A.skyConstellations.filter(c => c.name === '猎户座')[0];
    if (!ori) return { err: '没找到猎户座' };

    const sp = A.camera.position.clone();
    const sq = A.camera.quaternion.clone();
    A.controls.enabled = false;
    A.camera.position.copy(ori.dir).multiplyScalar(380);
    A.camera.lookAt(0, 0, 0);
    A.skyUpdate();

    const col = A.skyLineMesh.geometry.attributes.color.array;
    let mx = -1;
    for (let i = 0; i < col.length; i += 3) if (col[i] > mx) mx = col[i];

    A.camera.position.copy(sp);
    A.camera.quaternion.copy(sq);
    A.controls.enabled = true;
    A.skyUpdate();
    return { mx };
  });
  ok(!skyOutside.err && skyOutside.mx > 0.95,
     '相机退到壳外（380 > 300）也不整片淡掉——判据是相对相机的方向',
     skyOutside.err || '正对处系数 ' + skyOutside.mx.toFixed(3) +
                       '（写成相对原点的话这里会是 ' + skyView.floor + '）');

  /* ---- 窄屏：名字不能一个都出不来 ----
     面板避让原来判的是「x 在不在左右两栏之间」，而窄屏（≤820px）下左栏被
     收成了屏幕底部一条署名空壳（见 style.css 的媒体查询）—— left 18、
     宽 184.8 都还在，于是「两栏」之间的缝只剩 3px，标签被筛得一个不剩，
     而画面上看不出任何异常，只是没名字。这条专门守它。 */
  await page.setViewport({ width: 380, height: 780 });
  await sleep(900);
  const skyNarrow = await page.evaluate(() => {
    const A = window.__solaris;
    const ori = A.skyConstellations.filter(c => c.name === '猎户座')[0];
    if (!ori) return { err: '没找到猎户座' };

    const sp = A.camera.position.clone();
    const sq = A.camera.quaternion.clone();
    A.controls.enabled = false;
    A.camera.position.copy(ori.dir).multiplyScalar(-105);
    A.camera.lookAt(0, 0, 0);
    A.skyUpdate();

    const shown = (A.skyLabelEls() || []).filter(e => !e.hidden).map(e => e.textContent);

    A.camera.position.copy(sp);
    A.camera.quaternion.copy(sq);
    A.controls.enabled = true;
    A.skyUpdate();
    return { shown, w: window.innerWidth };
  });
  ok(!skyNarrow.err && skyNarrow.shown.length >= 1,
     '窄屏（380px）下正对某个星座也有名字——左栏收成署名条后仍占着老的 x 区间',
     skyNarrow.err || skyNarrow.w + 'px：' +
                      (skyNarrow.shown.join('、') || '（一个都没有）'));

  await page.setViewport({ width: 1440, height: 950 });
  await sleep(700);

  /* ---- 两只按钮 + 那行标注 ---- */
  ok(!sky.conHidden && sky.conOn && sky.visible,
     '恒星模式：星座线按钮在、亮着、壳层可见');
  ok(sky.orbHidden,
     '恒星模式：轨道线按钮收起来了（那圈线挂在 worldSolar 里，按下去不会有反应）');
  ok(sky.note, '「外壳 = 投影 / 内层 = 真实距离」那行标注露出来了');

  /* 关掉它，然后把状态一路带到太阳系去 —— 串味就是在这儿发生的。
     先按掉那个档案浮层：上面刚点过左栏第 3 行，右侧 410px 宽的面板正压在
     控制台上，不关掉这一击会落在面板上（点模式按钮时踩过同一个坑）。 */
  await page.keyboard.press('Escape');
  await sleep(600);
  await page.click('#btn-constel');
  await sleep(600);
  ok(await page.evaluate(() => !window.__solaris.skyGroup.visible &&
      !document.querySelector('#btn-constel').classList.contains('is-on')),
     '点一下，壳层和按钮的亮灭一起翻');

  /* 标签是 DOM，不在 worldStars 底下，visible = false 收不走它 —— 显隐必须
     由 updateSkyLayer 每帧自己判。这里稍等一会儿，让动画帧真的跑过 */
  await sleep(600);
  ok(await page.evaluate(() => {
    const box = document.querySelector('#sky-labels');
    const els = window.__solaris.skyLabelEls() || [];
    return box.hidden && els.every(e => e.hidden);
  }), '关掉星座线之后，屏幕上的名字也全收了（DOM 不在 worldStars 底下，收不住）');

  await page.keyboard.press('Escape');
  await sleep(500);
  await page.click('#btn-mode');
  await sleep(2300);
  const back = await page.evaluate(() => {
    const A = window.__solaris;
    const o = document.querySelector('#btn-orbits');
    return {
      mode: A.state.mode, planets: A.planets.length,
      picks: A.activePickables().length,
      rows: document.querySelectorAll('.planet-list .p-item').length,
      max: A.controls.maxDistance,
      showOrbits: A.state.showOrbits,
      orbHidden: o.hidden, orbOn: o.classList.contains('is-on'),
      conHidden: document.querySelector('#btn-constel').hidden,
      noteHidden: document.querySelector('#list-note').hidden,
    };
  });
  ok(back.mode === 'solar' && back.planets === before.planets,
     '切回来行星一个没少一个没多——证明是显隐而不是重建',
     before.planets + ' → ' + back.planets);
  ok(back.picks === before.picks && back.rows === before.rows,
     '拾取列表和左栏行数都还原了', before.picks + ' → ' + back.picks);
  ok(back.max === 620, '相机限制也还原了', back.max);
  /* 上面在恒星模式里把壳层关掉了，这里要看的是它有没有顺手把太阳系的
     轨道线也关掉 —— 两个开关各记各的状态，串味正是从这种地方开始的 */
  ok(back.showOrbits === before.showOrbits && !back.orbHidden && back.orbOn,
     '切回太阳系：轨道线按钮回来了、还亮着——关壳层没把它带跑',
     'showOrbits ' + back.showOrbits + ' / 按钮 ' +
     (back.orbHidden ? '藏着' : '在') + (back.orbOn ? '、亮' : '、灭'));
  ok(back.conHidden && back.noteHidden, '星座线按钮和那行标注都收回去了');

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
