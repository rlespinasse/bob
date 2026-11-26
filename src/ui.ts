/** Web UI minimale : liste des brains, création, changement de niveau, journal d'audit. */
export function page(): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bob</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 0 16px 32px; max-width: 980px; margin-inline: auto; }
  header { padding: 16px 0; border-bottom: 1px solid #8884; display: flex; justify-content: space-between; }
  h1 { font-size: 1.2rem; margin: 0; }
  h2 { font-size: 1rem; margin: 28px 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #8883; }
  .tag { padding: 1px 8px; border-radius: 10px; font-size: .8rem; }
  .open { background: #2a7a3a33; } .restricted { background: #b8860b33; } .forbidden { background: #b2222233; }
  .warn { color: #b8860b; font-size: .8rem; }
  form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  input, select, button { font: inherit; padding: 4px 8px; }
  #msg { min-height: 1.4em; color: #b22222; }
  code { font-size: .85rem; }
</style>
</head>
<body>
<header><h1>Bob · second brains</h1><span>127.0.0.1 uniquement</span></header>
<p id="msg"></p>
<h2>Brains</h2>
<table><thead><tr><th>Brain</th><th>Niveau</th><th>Proxy</th><th>Moteur</th><th>Connecteurs</th><th>Chiffrement</th><th></th></tr></thead>
<tbody id="brains"></tbody></table>
<h2>Créer un brain</h2>
<form id="create">
  <select name="kind"><option>client</option><option>team</option><option>agency</option><option>personal</option></select>
  <input name="slug" placeholder="slug client (ex. acme)">
  <select name="sensitivity"><option value="">restricted (défaut)</option><option>open</option><option>restricted</option><option>forbidden</option></select>
  <button>Créer</button>
</form>
<h2>Journal d'audit</h2>
<table><thead><tr><th>Date</th><th>Événement</th><th>Brain</th><th>Détails</th></tr></thead><tbody id="audit"></tbody></table>
<script>
const $ = (s) => document.querySelector(s);
const msg = (t) => { $('#msg').textContent = t || ''; };
async function api(path, options) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
function cell(text, cls) {
  const td = document.createElement('td');
  if (cls) { const s = document.createElement('span'); s.className = 'tag ' + cls; s.textContent = text; td.append(s); }
  else td.textContent = text;
  return td;
}
async function refresh() {
  const brains = await api('/api/brains');
  const body = $('#brains'); body.replaceChildren();
  for (const b of brains) {
    const tr = document.createElement('tr');
    tr.append(cell(b.id), cell(b.sensitivity, b.sensitivity), cell(b.proxy.profile), cell(b.engine),
      cell(b.connectors.enabled.join(', ') || 'aucun'), cell(b.encryption ? 'oui' : 'non (M3)'));
    const td = document.createElement('td');
    const sel = document.createElement('select');
    for (const l of ['open', 'restricted', 'forbidden']) { const o = new Option(l, l); o.selected = l === b.sensitivity; sel.add(o); }
    sel.onchange = async () => {
      if (!confirm('Changer le niveau de ' + b.id + ' vers ' + sel.value + ' ?')) { sel.value = b.sensitivity; return; }
      try { await api('/api/brains/level', { method: 'PATCH', body: JSON.stringify({ id: b.id, sensitivity: sel.value, confirmed: true }) }); msg(''); } catch (e) { msg(e.message); }
      refresh();
    };
    td.append(sel);
    const launch = document.createElement('button');
    launch.textContent = 'Lancer';
    launch.onclick = async () => {
      try { const r = await api('/api/launch', { method: 'POST', body: JSON.stringify({ id: b.id }) }); msg('Dans un terminal : ' + r.command); }
      catch (e) { msg(e.message); }
      refresh();
    };
    const stop = document.createElement('button');
    stop.textContent = 'Arrêter';
    stop.onclick = async () => { try { await api('/api/stop', { method: 'POST', body: JSON.stringify({ id: b.id }) }); msg(''); } catch (e) { msg(e.message); } refresh(); };
    td.append(' ', launch, ' ', stop);
    for (const i of b.issues) { const w = document.createElement('div'); w.className = 'warn'; w.textContent = i.message; td.append(w); }
    tr.append(td); body.append(tr);
  }
  const audit = await api('/api/audit?limit=20');
  const ab = $('#audit'); ab.replaceChildren();
  for (const a of audit) {
    const tr = document.createElement('tr');
    tr.append(cell(a.ts), cell(a.event), cell(a.brain || ''), cell(JSON.stringify(a.details)));
    ab.append(tr);
  }
}
$('#create').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const data = { kind: f.get('kind') };
  if (f.get('slug')) data.slug = f.get('slug');
  if (f.get('sensitivity')) data.sensitivity = f.get('sensitivity');
  try { await api('/api/brains', { method: 'POST', body: JSON.stringify(data) }); msg(''); e.target.reset(); } catch (err) { msg(err.message); }
  refresh();
};
refresh().catch((e) => msg(e.message));
</script>
</body>
</html>`;
}
