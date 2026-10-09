"""Exercise the actual WebView2 desktop renderer without opening a visible window."""
from pathlib import Path
import json
import os
import threading
import time
import traceback
import webview
from http.server import ThreadingHTTPServer
from serve import NoCacheHandler

root = Path(__file__).resolve().parents[1]
os.environ['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = '--disable-background-timer-throttling --disable-renderer-backgrounding'
report = {"checks": []}
server = ThreadingHTTPServer(('127.0.0.1', 0), NoCacheHandler)
preview_url = 'http://127.0.0.1:' + str(server.server_port) + '/'
page = (root / 'workbench.html').read_text(encoding='utf-8')
page = page.replace('<head>', '<head><base href="' + preview_url + '"><script>window.smokeErrors=[];window.onerror=(m,s,l)=>smokeErrors.push(m+" at "+s+":"+l);window.onunhandledrejection=e=>smokeErrors.push(String(e.reason));</script>')
window = webview.create_window('Relief verification', html=page, width=1100, height=750, min_size=(680,480), hidden=True)

def check(name, expression):
    result = window.evaluate_js(expression)
    if not result:
        raise AssertionError(name + ': ' + repr(result))
    report['checks'].append(name)
    print('PASS', name, flush=True)
    return result

def run():
    try:
        time.sleep(2)
        print('ERRORS', window.evaluate_js('window.smokeErrors'), flush=True)
        check('boot', 'Boolean(TOPIC && currentSession && document.querySelectorAll(".wcard").length === 12)')
        report['profiles'] = window.evaluate_js('Object.values(TOPICS).map(p=>({id:p.id,files:p.fileList().length,lines:p.fileList().reduce((n,f)=>n+f[1].split("\\n").length-1,0),largest:Math.max(...p.fileList().map(f=>f[1].split("\\n").length-1))}))')
        check('all profile trees and source modules', '''(()=>{ for(const id of Object.keys(TOPICS)){loadTopic(id);if(Object.keys(REG).length<16||!Object.values(REG).some(f=>f.lines.length>1000))return false;for(const panel of ['PROBLEMS','OUTPUT','DEBUG CONSOLE','TERMINAL','PORTS'])setPanel(panel);}return true;})()''')
        window.evaluate_js("loadTopic('mobile');welcomeEl.classList.remove('show');runCommand('pwd');")
        check('terminal pwd', 'termEl.textContent.includes("pulse-mobile")')
        window.evaluate_js("runCommand('cd src');")
        check('terminal cd', 'currentSession.cwd === "src"')
        window.evaluate_js("runCommand('cat api/types.ts');")
        check('terminal cat', 'termEl.textContent.includes("SyncCheckpoint")')
        window.evaluate_js("runCommand('git switch develop');")
        check('git checkout', 'TOPIC.branch === "develop"')
        window.evaluate_js("runCommand('not-a-real-command');")
        check('invalid command', 'currentSession.exitCode === 127')
        window.evaluate_js("runCommand('npm test');")
        for _ in range(200):
            if window.evaluate_js('!currentSession.busy'): break
            time.sleep(.1)
        check('test task finishes', '!currentSession.busy && termEl.textContent.includes("25 passed")')
        window.evaluate_js("runCommand('npm test');cancelCommand();")
        time.sleep(.5)
        check('task cancellation', '!currentSession.busy && currentSession.exitCode === 130')
        window.evaluate_js("makeSession();runCommand('echo second-terminal');selectSession(sessions[0].id);")
        check('terminal sessions isolated', '!termEl.textContent.includes("second-terminal")')
        window.evaluate_js("runCommand('npm test');loadTopic('gobackend');")
        time.sleep(.5)
        check('switch cancels old task', '!termEl.textContent.includes("sync.engine") && !currentSession.busy')
        window.evaluate_js("loadTopic('mobile');settings.strict=true;autopilot=false;document.activeElement.blur();")
        check('exact typing advances', '''(()=>{const f=REG[ap],pos=f.st.pos;const k=f.content[pos];document.dispatchEvent(new KeyboardEvent('keydown',{key:k==='\\n'?'Enter':k,bubbles:true}));return f.st.pos>pos;})()''')
        check('incorrect typing does not advance', '''(()=>{const f=REG[ap],pos=f.st.pos;document.dispatchEvent(new KeyboardEvent('keydown',{key:'§',bubbles:true}));return f.st.pos===pos;})()''')
        window.evaluate_js("commandPalette();")
        check('command palette', 'document.querySelectorAll("#choices button").length > 30')
        window.evaluate_js("closeDialog();preferences();")
        check('settings dialog', 'Boolean(document.querySelector("#setting-mode"))')
        window.evaluate_js("closeDialog();startDebug();stepDebug();stopDebug();")
        check('debug lifecycle', '!debugging && debugLog.some(l=>l.includes("Step 1"))')
        window.evaluate_js("editSource();document.getElementById('source-edit').value='// edited locally\\n';document.getElementById('source-save').click();")
        check('source editing', 'REG[ap].content === "// edited locally\\n"')
        window.resize(720, 520)
        time.sleep(.3)
        check('compact window dimensions', 'innerWidth <= 720 && innerHeight <= 520 && document.body.scrollWidth <= innerWidth')
        check('no runtime errors', 'smokeErrors.length === 0')
        report['ok'] = True
    except Exception:
        report['ok'] = False
        report['error'] = traceback.format_exc()
        print(report['error'], flush=True)
        try: report['runtimeErrors'] = window.evaluate_js('window.smokeErrors')
        except Exception: pass
    finally:
        (root/'tools/smoke-results.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        window.destroy()

threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    webview.start(run)
finally:
    server.shutdown()
    server.server_close()
raise SystemExit(0 if report.get('ok') else 1)
