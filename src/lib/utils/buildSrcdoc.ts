export function buildReactSrcdoc(code: string, channel: string): string {
	// Strip ES module import/export syntax — React & ReactDOM are UMD globals loaded from CDN
	const clean = code
		.replace(/^import\s+[^\n]+from\s+['"][^'"]+['"]\s*;?\s*\n?/gm, "")
		.replace(/export\s+default\s+function\s+(\w+)/g, "function $1")
		.replace(/export\s+default\s+class\s+(\w+)/g, "class $1")
		.replace(/export\s+default\s+(\w+)\s*;?\s*$/, "var __defaultExport__ = $1")
		.replace(/export\s+\{[^}]+\}\s*;?\s*/g, "")
		// prevent user code from breaking out of the <script type="text/babel"> tag
		.replace(/<\/script/gi, "<\\/script");

	const endScriptTag = "</scr" + "ipt>";

	const scaffold =
		`<!doctype html>\n<html>\n<head>\n` +
		`  <meta charset="utf-8">\n` +
		`  <meta name="viewport" content="width=device-width, initial-scale=1">\n` +
		`  <script src="https://unpkg.com/react@18/umd/react.development.js" crossorigin>${endScriptTag}\n` +
		`  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js" crossorigin>${endScriptTag}\n` +
		`  <script src="https://unpkg.com/@babel/standalone/babel.min.js">${endScriptTag}\n` +
		`  <script src="https://cdn.tailwindcss.com">${endScriptTag}\n` +
		`  <style>body{margin:0;font-family:system-ui,sans-serif}*{box-sizing:border-box}</style>\n` +
		`</head>\n<body>\n` +
		`  <div id="__react_root"></div>\n` +
		`  <script type="text/babel">\n` +
		`const{useState,useEffect,useRef,useCallback,useMemo,useReducer,useContext,createContext,Fragment,memo,forwardRef,lazy,Suspense}=React;\n` +
		clean +
		`\n;(function(){\n` +
		`  var __comp=typeof App!=='undefined'?App:typeof __defaultExport__!=='undefined'?__defaultExport__:null;\n` +
		`  if(__comp){ReactDOM.createRoot(document.getElementById('__react_root')).render(React.createElement(__comp));}\n` +
		`  else{document.getElementById('__react_root').innerHTML='<div style="color:red;padding:16px">No component found — define an <code>App</code> function.</div>';}\n` +
		`})();\n` +
		`  ${endScriptTag}\n` +
		`</body>\n</html>`;

	return buildSrcdoc(scaffold, channel);
}

export function buildSrcdoc(content: string, channel: string): string {
	const trimmed = content.trimStart();
	const svgPattern = /^(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+svg[^>]*>\s*)?<svg[\s>]/i;
	const baseTag = '<base target="_blank">';
	const disabledLinkStyles = `<style>
		a[data-chatui-link-disabled] {}
	</style>`;
	const endScriptTag = "</scr" + "ipt>";
	const errorHook = `\n<script>\n(function(){\n  function send(detail){\n    try{ parent.postMessage({ type: 'chatui.preview.error', channel: '${channel}', detail: detail }, '*'); }catch(e){}\n  }\n  function markDisabled(anchor){\n    if (!anchor || anchor.dataset.chatuiLinkDisabled === 'true') return;\n    anchor.dataset.chatuiLinkDisabled = 'true';\n    var note = 'Link disabled in preview';\n    var title = anchor.getAttribute('title');\n    if (!title) {\n      anchor.setAttribute('title', note);\n    } else if (title.indexOf(note) === -1) {\n      anchor.setAttribute('title', title + ' — ' + note);\n    }\n  }\n  function disableAnchors(scope){\n    try {\n      var root = scope && scope.querySelectorAll ? scope : document;\n      var anchors = root.querySelectorAll ? root.querySelectorAll('a') : [];\n      for (var i = 0; i < anchors.length; i++) {\n        markDisabled(anchors[i]);\n      }\n    } catch (err) {}\n  }\n  function nearestAnchor(node){\n    while (node && node !== document) {\n      if (node.tagName && node.tagName.toLowerCase() === 'a') return node;\n      node = node.parentNode;\n    }\n    return null;\n  }\n  function intercept(ev){\n    var anchor = nearestAnchor(ev.target);\n    if (!anchor) return;\n    markDisabled(anchor);\n    ev.preventDefault();\n    ev.stopPropagation();\n  }\n  disableAnchors();\n  if (document.readyState === 'loading') {\n    document.addEventListener('DOMContentLoaded', function(){ disableAnchors(); });\n  } else {\n    setTimeout(function(){ disableAnchors(); }, 0);\n  }\n  if (window.MutationObserver) {\n    var observer = new MutationObserver(function(mutations){\n      for (var i = 0; i < mutations.length; i++) {\n        var nodes = mutations[i].addedNodes;\n        for (var j = 0; j < nodes.length; j++) {\n          var node = nodes[j];\n          if (!node || node.nodeType !== 1) continue;\n          if (node.tagName && node.tagName.toLowerCase() === 'a') {\n            markDisabled(node);\n          } else {\n            disableAnchors(node);\n          }\n        }\n      }\n    });\n    observer.observe(document.documentElement, { childList: true, subtree: true });\n  }\n  window.addEventListener('click', intercept, true);\n  window.addEventListener('auxclick', intercept, true);\n  window.addEventListener('keydown', function(ev){\n    if (ev.key === 'Enter' || ev.key === ' ') {\n      intercept(ev);\n    }\n  }, true);\n  window.addEventListener('error', function(ev){\n    var msg = ev && ev.message ? ev.message : 'Script error';\n    var stack = ev && ev.error && ev.error.stack ? ev.error.stack : undefined;\n    send({ message: msg, stack: stack });\n  });\n  window.addEventListener('unhandledrejection', function(ev){\n    var r = ev && ev.reason;\n    var msg = (typeof r === 'string') ? r : (r && r.message) ? r.message : 'Unhandled promise rejection';\n    var stack = r && r.stack ? r.stack : undefined;\n    send({ message: msg, stack: stack });\n  });\n})();\n${endScriptTag}`;

	if (svgPattern.test(trimmed)) {
		const svgContent = trimmed
			.replace(/^(<\?xml[^>]*>\s*)/i, "")
			.replace(/^(<!doctype[^>]*>\s*)/i, "");
		return `<!doctype html><html><head>${baseTag}${disabledLinkStyles}${errorHook}</head><body>${svgContent}</body></html>`;
	}

	const headMatch = content.match(/<head[^>]*>/i);
	if (headMatch) {
		return content.replace(headMatch[0], headMatch[0] + baseTag + disabledLinkStyles + errorHook);
	}
	const htmlTagMatch = content.match(/<html[^>]*>/i);
	if (htmlTagMatch) {
		return content.replace(
			htmlTagMatch[0],
			htmlTagMatch[0] + "\n<head>" + baseTag + disabledLinkStyles + errorHook + "</head>"
		);
	}
	const doctypeMatch = content.match(/<!doctype[^>]*>/i);
	if (doctypeMatch) {
		const idx = content.indexOf(doctypeMatch[0]) + doctypeMatch[0].length;
		return (
			content.slice(0, idx) +
			"\n<head>" +
			baseTag +
			disabledLinkStyles +
			errorHook +
			"</head>" +
			content.slice(idx)
		);
	}
	return "<head>" + baseTag + disabledLinkStyles + errorHook + "</head>\n" + content;
}
