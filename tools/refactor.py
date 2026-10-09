from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
page = (root / 'workbench.html').read_text(encoding='utf-8')
js = page.split('<script>')[1].split('</script>')[0]
start = js.index('/* ================= generated config corpus')
end = js.index('const TOPICS =')
js = js[:start] + js[end:]
boot = js.index('/* ================= boot ================= */')
(root / 'app/boot.js').write_text(js[boot:], encoding='utf-8')
js = js[:boot]
js = js.replace("const d = DBG[TOPIC.id];", "const d = TOPIC.debug || DBG[TOPIC.id];")
js = js.replace("DBG[TOPIC.id].conf", "(TOPIC.debug || DBG[TOPIC.id]).conf")
js = js.replace("window.addEventListener('pywebviewready', () => {", "window.addEventListener('pywebviewready', () => {\n  document.body.classList.add('desktop-shell');")
js = js.replace("  autopilot = !autopilot;\n  branchEl.classList.toggle('auto', autopilot);", "  chooseBranch();")
js = js.replace("  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;", "  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;")
js = js.replace("  if (!REG[p] || p === ap) return;", "  if (!REG[p]) return;\n  if (REG[p].typed) rotIdx = rotation.indexOf(p);\n  if (p === ap && openTabs.includes(p)) return;")
js = js.replace("  const checker = TOPIC.termproc.startsWith('python') ? 'pyright' : 'tsc';", "  const checker = TOPIC.checker || 'tsc';")
js = js.replace("  rotation = TOPIC.fileList().filter(e => e[2]).map(e => e[0]);", "  rotation = Object.values(REG).filter(f => f.typed).map(f => f.path);")
# Empty shell chrome is replaced with working controls by workbench.js.
js = js.replace("  document.getElementById('termlabel').textContent = TOPIC.termproc + ' ▾ ＋ 🗑';", "")
js = re.sub(r'async function termLoop\(\) \{[\s\S]*?\n\}\n', 'async function termLoop() { /* Session-aware scheduler lives in workbench.js. */ }\n', js, count=1)
# Keep old profiles, grow their main modules, and use the new deterministic generators.
js = js.replace(', 560), true]', ', 1200), true]').replace(', 540), true]', ', 1200), true]').replace(', 520), true]', ', 1200), true]')
(root / 'app/engine.js').write_text(js, encoding='utf-8')
scripts = ['generators.js', 'engine.js', 'profiles.js', 'corpus/gamedev.js', 'corpus/enterprise.js', 'corpus/dataeng.js', 'corpus/mobile.js', 'catalogue.js', 'workbench.js', 'boot.js']
page = page.split('<script>')[0] + '\n'.join('<script src="app/' + s + '"></script>' for s in scripts) + '\n</body>\n</html>\n'
page = page.replace('</style>', '</style>\n<link rel="stylesheet" href="app/workbench.css">')
page = page.replace('Focus L1', 'Ln service').replace('Focus rank: gain XP by typing the suggested code correctly', 'Language service status')
page = page.replace('Message (leave empty for an honest one)', 'Message (Ctrl+Enter to commit)')
page = page.replace('Typing timer, words per minute, and accuracy', 'Editor activity')
(root / 'workbench.html').write_text(page, encoding='utf-8')
