from pathlib import Path
from io import BytesIO
import zipfile,json,base64
root=Path(__file__).resolve().parent.parent
# Fixed project-source allowlist; never enumerate runtime filesystem or secrets.
folders=['src','shared','server','cloudflare','catalog','public','tests','scripts']
files=['package.json','package-lock.json','README.md','LICENSE','index.html','server.ts','vite.config.ts','tsconfig.json','worker-configuration.d.ts','wrangler.jsonc','CLOUDFLARE.md','.gitignore','.env.example']
paths=[root/f for f in files]
for folder in folders:
 paths.extend((root/folder).rglob('*'))
out=BytesIO()
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
 for p in sorted(set(paths)):
  if not p.is_file() or p.name=='source-archive.json' or p.suffix in ['.db','.log','.pem','.key','.jks','.keystore','.p12','.pfx'] or p.name.startswith('.dev.vars'):continue
  z.write(p,p.relative_to(root))
(root/'cloudflare/source-archive.json').write_text(json.dumps({'base64':base64.b64encode(out.getvalue()).decode()}))
print('Packaged curated project source',len(out.getvalue()),'bytes')
