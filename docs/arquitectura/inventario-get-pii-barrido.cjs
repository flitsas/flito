#!/usr/bin/env node
// Barrido mecanico de rutas Express de apps/api (HU #13986). Solo lee codigo; no toca BD ni red.
// Uso: node barrido.cjs <raiz-del-repo> <dir-salida>
// Salida: rutas.json, y un resumen en stdout.
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(process.argv[2] || '.'); const OUT = path.resolve(process.argv[3] || '.');
const ts = require(path.join(ROOT, 'node_modules/typescript'));
const SRC = path.join(ROOT, 'apps/api/src');
const METHODS = new Set(['get','post','put','patch','delete','all','head','options']);
const walk = d => fs.readdirSync(d,{withFileTypes:true}).flatMap(e => {
  const p = path.join(d,e.name);
  if (e.isDirectory()) return e.name==='__tests__'||e.name==='node_modules' ? [] : walk(p);
  return /\.ts$/.test(e.name)&&!/\.(test|spec|d)\.ts$/.test(e.name) ? [p] : [];
});
const rel = f => path.relative(ROOT,f);
const files = new Map();
for (const f of walk(SRC)) {
  const text = fs.readFileSync(f,'utf8');
  files.set(f,{f,text,sf:ts.createSourceFile(f,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),imports:new Map(),decls:new Map(),routerVars:new Set(),defaultExport:null,exportAlias:new Map(),routes:[],uses:[]});
}
const lineOf=(F,n)=>F.sf.getLineAndCharacterOfPosition(n.getStart(F.sf)).line+1;
const resolveImp=(from,spec)=>{ if(!spec.startsWith('.'))return null; const b=path.resolve(path.dirname(from),spec.replace(/\.js$/,''));
  for(const c of [b+'.ts',path.join(b,'index.ts')]) if(files.has(c)) return c; return null; };
// ---- indice por archivo
for (const F of files.values()) {
  const visit=n=>{
    if(ts.isImportDeclaration(n)&&n.importClause){ const t=resolveImp(F.f,n.moduleSpecifier.text); const ic=n.importClause;
      if(ic.name) F.imports.set(ic.name.text,{file:t,name:'default'});
      if(ic.namedBindings&&ts.isNamedImports(ic.namedBindings)) for(const e of ic.namedBindings.elements) F.imports.set(e.name.text,{file:t,name:(e.propertyName||e.name).text});
    }
    if(ts.isExportDeclaration(n)&&n.exportClause&&ts.isNamedExports(n.exportClause)){
      for(const e of n.exportClause.elements){ F.exportAlias.set(e.name.text,{local:(e.propertyName||e.name).text,from:n.moduleSpecifier?resolveImp(F.f,n.moduleSpecifier.text):null}); }
    }
    if(ts.isExportAssignment(n)&&!n.isExportEquals&&ts.isIdentifier(n.expression)) F.defaultExport=n.expression.text;
    if(ts.isFunctionDeclaration(n)&&n.name) { F.decls.set(n.name.text,n); if(n.modifiers&&n.modifiers.some(m=>m.kind===ts.SyntaxKind.DefaultKeyword)) F.defaultExport=n.name.text; }
    if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer){
      F.decls.set(n.name.text,n.initializer);
      const it=n.initializer.getText(F.sf);
      if(/^(express\.)?Router\(/.test(it)) F.routerVars.add(n.name.text);
    }
    if(ts.isParameter(n)&&ts.isIdentifier(n.name)&&n.type&&/^(Router|Express|Application)$/.test(n.type.getText(F.sf))) F.routerVars.add(n.name.text);
    ts.forEachChild(n,visit);
  };
  visit(F.sf);
  if(/\/app\.ts$/.test(F.f)) F.routerVars.add('app');
}
// ---- registro de rutas y usos
const unwrapCalleeName=(F,c)=>ts.isIdentifier(c.expression)?c.expression.text:ts.isPropertyAccessExpression(c.expression)?c.expression.name.text:c.expression.getText(F.sf);
const litPath=(F,n)=>{ if(ts.isStringLiteralLike(n))return n.text;
  if(ts.isTemplateExpression(n))return n.getText(F.sf).slice(1,-1);
  if(ts.isArrayLiteralExpression(n)) return n.elements.map(e=>litPath(F,e));
  if(ts.isRegularExpressionLiteral(n)) return 'RE:'+n.text;
  if(ts.isIdentifier(n)){ const d=resolveVal(F,n.text); if(d&&ts.isStringLiteralLike(d.node))return d.node.text; }
  return null; };
function resolveVal(F,name,seen=new Set()){ const k=F.f+'#'+name; if(seen.has(k))return null; seen.add(k);
  if(F.decls.has(name)) return {F,node:F.decls.get(name)};
  const a=F.exportAlias.get(name); if(a){ if(a.from) return resolveExport(files.get(a.from),a.local,seen); return resolveVal(F,a.local,seen); }
  const imp=F.imports.get(name); if(imp&&imp.file) return resolveExport(files.get(imp.file),imp.name,seen); return null; }
function resolveExport(F,name,seen=new Set()){ if(!F)return null;
  if(name==='default'&&F.defaultExport) return resolveVal(F,F.defaultExport,seen)||{F,node:null,local:F.defaultExport};
  return resolveVal(F,name,seen); }
const routerIdOf=(F,name,seen=new Set())=>{ const k=F.f+'#'+name; if(seen.has(k))return null; seen.add(k);
  if(F.routerVars.has(name)) return {file:F.f,var:name};
  const a=F.exportAlias.get(name); if(a){ if(a.from){const T=files.get(a.from); return T&&routerIdOf(T,a.local,seen);} return routerIdOf(F,a.local,seen);}
  const imp=F.imports.get(name); if(imp&&imp.file){ const T=files.get(imp.file); if(!T)return null;
    if(imp.name==='default'){ if(T.defaultExport) return routerIdOf(T,T.defaultExport,seen); const al=T.exportAlias.get('default'); return al?routerIdOf(al.from?files.get(al.from):T,al.local,seen):null;} return routerIdOf(T,imp.name,seen);} 
  const d=F.decls.get(name); if(d&&ts.isCallExpression(d)){ // const r = conAlcance('x', y) o fabrica
    for(const a of d.arguments) if(ts.isIdentifier(a)){ const r=routerIdOf(F,a.text,seen); if(r)return r; }
    const c=ts.isIdentifier(d.expression)?resolveVal(F,d.expression.text):null; if(c&&c.node){ const r=routerOfFactory(c.F,c.node); if(r)return r; } }
  return null; };
function routerOfFactory(F,fn){ let found=null; const v=n=>{ if(found)return; if(ts.isReturnStatement(n)&&n.expression&&ts.isIdentifier(n.expression)&&F.routerVars.has(n.expression.text)) found={file:F.f,var:n.expression.text}; ts.forEachChild(n,v); }; v(fn); return found; }
const unresolvedCandidates=[];
for (const F of files.values()) {
  const v=n=>{
    if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)){
      const m=n.expression.name.text; let obj=n.expression.expression;
      let chained=null;
      if(ts.isCallExpression(obj)&&ts.isPropertyAccessExpression(obj.expression)&&obj.expression.name.text==='route'&&ts.isIdentifier(obj.expression.expression)){ chained=litPath(F,obj.arguments[0]); obj=obj.expression.expression; }
      if(ts.isIdentifier(obj)){
        const isR=F.routerVars.has(obj.text);
        if(METHODS.has(m)&&n.arguments.length>=(chained?1:2)){
          const p=chained??litPath(F,n.arguments[0]);
          if(isR){ F.routes.push({method:m.toUpperCase(),path:p,pathText:n.arguments[0].getText(F.sf),routerVar:obj.text,line:lineOf(F,n),pos:n.getStart(F.sf),args:(chained?[...n.arguments]:[...n.arguments].slice(1))}); }
          else if(p!==null&&typeof p==='string'&&p.startsWith('/')&&n.arguments.some(a=>ts.isArrowFunction(a)||ts.isFunctionExpression(a))) unresolvedCandidates.push(`${rel(F.f)}:${lineOf(F,n)} ${obj.text}.${m}(${p})`);
        }
        if(m==='use'&&isR){
          const a0=n.arguments[0]; let prefix=''; let rest=[...n.arguments];
          const lp=a0&&litPath(F,a0); if(typeof lp==='string'&&(lp.startsWith('/')||lp==='')){prefix=lp;rest=rest.slice(1);}
          F.uses.push({routerVar:obj.text,prefix,args:rest,line:lineOf(F,n),pos:n.getStart(F.sf)});
        }
      }
    }
    ts.forEachChild(n,v);
  };
  v(F.sf);
}
// ---- montajes
const key=(file,v)=>file+'#'+v;
const mounts=new Map(); // routerKey -> [{parentKey,prefix,line,wrappers}]
for(const F of files.values()) for(const u of F.uses) for(const a of u.args){
  const add=(name,wrap)=>{ const r=routerIdOf(F,name); if(r&&!(r.file===F.f&&r.var===u.routerVar)){ const k=key(r.file,r.var); if(!mounts.has(k))mounts.set(k,[]); mounts.get(k).push({parent:key(F.f,u.routerVar),prefix:u.prefix,line:u.line,file:F.f,wrap,pos:u.pos}); u.mountedRouter=true; return true;} return false; };
  if(ts.isIdentifier(a)) add(a.text,null);
  else if(ts.isCallExpression(a)){ const cn=unwrapCalleeName(F,a); let ok=false; for(const x of a.arguments) if(ts.isIdentifier(x)) ok=add(x.text,cn)||ok;
    if(!ok){ const c=ts.isIdentifier(a.expression)?resolveVal(F,a.expression.text):null; if(c&&c.node){const r=routerOfFactory(c.F,c.node); if(r){const k=key(r.file,r.var); if(!mounts.has(k))mounts.set(k,[]); mounts.get(k).push({parent:key(F.f,u.routerVar),prefix:u.prefix,line:u.line,file:F.f,wrap:cn,pos:u.pos}); u.mountedRouter=true;}} }
  }
}
const appKey=key(path.join(SRC,'app.ts'),'app');
function chains(k,seen=new Set()){ if(k===appKey) return [{prefix:'',via:[]}]; if(seen.has(k))return []; const nx=new Set(seen);nx.add(k);
  const out=[]; for(const m of mounts.get(k)||[]) for(const c of chains(m.parent,nx)) out.push({prefix:c.prefix+m.prefix,via:[...c.via,m]}); return out; }
// ---- analisis de handlers
const TOUCHED=new Set();
const QUERY_TEXT=/\breq(uest)?\.query\b/;
function fnOf(n){ return n&&(ts.isArrowFunction(n)||ts.isFunctionExpression(n)||ts.isFunctionDeclaration(n))?n:null; }
function schemaKeys(F,node,seen=new Set(),res={keys:new Set(),unresolved:[]}){
  if(!node)return res;
  if(ts.isIdentifier(node)){ const k=F.f+'#'+node.text; if(seen.has(k))return res; seen.add(k); const d=resolveVal(F,node.text); if(d&&d.node) return schemaKeys(d.F,d.node,seen,res); if(!/^z$/.test(node.text)) res.unresolved.push(node.text); return res; }
  if(ts.isCallExpression(node)){
    const nm=ts.isPropertyAccessExpression(node.expression)?node.expression.name.text:ts.isIdentifier(node.expression)?node.expression.text:'';
    const isLocalFactory=ts.isIdentifier(node.expression);
    if(ts.isPropertyAccessExpression(node.expression)&&!['object','pipe','transform','default','optional','nullable','coerce'].includes(nm)||nm==='object'){}
    if(['object','extend','merge','strictObject','looseObject'].includes(nm)){ for(const a of node.arguments){ if(ts.isObjectLiteralExpression(a)){ for(const p of a.properties){ if((ts.isPropertyAssignment(p)||ts.isShorthandPropertyAssignment(p))&&p.name) res.keys.add(p.name.getText(F.sf).replace(/['"]/g,'')); else if(ts.isSpreadAssignment(p)) { const e=p.expression; if(ts.isPropertyAccessExpression(e)&&e.name.text==='shape') schemaKeys(F,e.expression,seen,res); else schemaKeys(F,e,seen,res);} } } else schemaKeys(F,a,seen,res); } }
    else if(isLocalFactory){ const d=resolveVal(F,node.expression.text); if(d&&d.node){ const fn=fnOf(d.node); if(fn){ const v=x=>{ if(ts.isCallExpression(x)&&ts.isPropertyAccessExpression(x.expression)&&/^(object|extend|merge|strictObject)$/.test(x.expression.name.text)) schemaKeys(d.F,x,seen,res); else ts.forEachChild(x,v); }; v(fn);} } else res.unresolved.push(node.expression.text); }
    if(ts.isPropertyAccessExpression(node.expression)) schemaKeys(F,node.expression.expression,seen,res);
    return res; }
  if(ts.isPropertyAccessExpression(node)) { if(node.name.text==='shape'||true) schemaKeys(F,node.expression,seen,res); return res; }
  if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)) return schemaKeys(F,node.expression,seen,res);
  return res;
}
function analyze(F,fn,ctx,depth,reqName,queryName){
  // reqName: nombre local del Request (o null); queryName: nombre local de un objeto query (o null)
  const id=F.f+':'+fn.pos+':'+reqName+':'+queryName; if(ctx.seen.has(id)||depth>5)return; ctx.seen.add(id);
  const aliases=new Set(queryName?[queryName]:[]); const reqAliases=new Set(reqName?[reqName]:[]);
  const isQ=n=>{ if(!n)return false; if(ts.isParenthesizedExpression(n)||ts.isAsExpression(n)||ts.isNonNullExpression(n)||(ts.isTypeAssertionExpression&&ts.isTypeAssertionExpression(n)))return isQ(n.expression);
    if(ts.isIdentifier(n))return aliases.has(n.text);
    if(ts.isPropertyAccessExpression(n)&&n.name.text==='query'&&ts.isIdentifier(n.expression)&&reqAliases.has(n.expression.text)){TOUCHED.add(rel(F.f)+':'+lineOf(F,n));return true;} return false; };
  const isR=n=>n&&ts.isIdentifier(n)&&reqAliases.has(n.text);
  const addQ=(name,node,via)=>{ ctx.query.set(name,`${rel(F.f)}:${lineOf(F,node)}${via?' ('+via+')':''}`); };
  // primera pasada: alias
  const pre=n=>{ if(ts.isVariableDeclaration(n)&&n.initializer&&isQ(n.initializer)&&ts.isIdentifier(n.name)) aliases.add(n.name.text); ts.forEachChild(n,pre); };
  if(fn.body) pre(fn.body);
  const v=n=>{
    if(ts.isPropertyAccessExpression(n)&&isQ(n.expression)) addQ(n.name.text,n);
    if(ts.isElementAccessExpression(n)&&isQ(n.expression)){ if(ts.isStringLiteralLike(n.argumentExpression)) addQ(n.argumentExpression.text,n); else ctx.opaque.push(`${rel(F.f)}:${lineOf(F,n)} indice dinamico`); }
    if(ts.isVariableDeclaration(n)&&n.initializer&&isQ(n.initializer)&&ts.isObjectBindingPattern(n.name)) for(const e of n.name.elements){ addQ((e.propertyName||e.name).getText(F.sf),n,'destructuring'); }
    if(ts.isCallExpression(n)){
      const a=[...n.arguments];
      const anyQ=a.findIndex(isQ); const anyR=a.findIndex(isR);
      const pn=ts.isPropertyAccessExpression(n.expression)?n.expression.name.text:'';
      if(anyQ>=0){
        if(pn==='parse'||pn==='safeParse'||pn==='parseAsync'||pn==='safeParseAsync'){
          const r=schemaKeys(F,n.expression.expression); ctx.schemas.push(`${rel(F.f)}:${lineOf(F,n)} ${n.expression.expression.getText(F.sf).slice(0,50)}`);
          r.keys.forEach(k=>addQ(k,n,'schema')); if(r.keys.size===0) ctx.opaque.push(`${rel(F.f)}:${lineOf(F,n)} schema sin llaves resueltas: ${n.expression.expression.getText(F.sf).slice(0,50)}`);
        } else if(ts.isIdentifier(n.expression)||pn){
          const fnName=ts.isIdentifier(n.expression)?n.expression.text:null; const d=fnName?resolveVal(F,fnName):null; const tf=d&&fnOf(d.node);
          if(tf&&tf.parameters[anyQ]&&ts.isIdentifier(tf.parameters[anyQ].name)){ ctx.helpers.push(`${rel(F.f)}:${lineOf(F,n)} ${fnName}(query)`); analyze(d.F,tf,ctx,depth+1,null,tf.parameters[anyQ].name.text);
            if(tf.parameters[anyQ]&&ts.isObjectBindingPattern(tf.parameters[anyQ].name)){} }
          else if(tf&&tf.parameters[anyQ]&&ts.isObjectBindingPattern(tf.parameters[anyQ].name)){ for(const e of tf.parameters[anyQ].name.elements) addQ((e.propertyName||e.name).getText(d.F.sf),n,'helper-destructuring'); }
          else if(pn==='keys'&&n.expression.getText(F.sf)==='Object.keys'){ ctx.queryRejected.push(`${rel(F.f)}:${lineOf(F,n)}`); }
          else ctx.opaque.push(`${rel(F.f)}:${lineOf(F,n)} query pasada a ${n.expression.getText(F.sf).slice(0,50)}`);
        }
      }
      const cname=ts.isIdentifier(n.expression)?n.expression.text:pn;
      if(cname==='logPiiAccess'&&(ts.isIdentifier(n.expression))) ctx.pii.push(`${rel(F.f)}:${lineOf(F,n)}`);
      if(anyR>=0&&ts.isIdentifier(n.expression)){
        const d=resolveVal(F,n.expression.text); const tf=d&&fnOf(d.node);
        if(tf&&tf.parameters[anyR]&&ts.isIdentifier(tf.parameters[anyR].name)){ ctx.reqHelpers.push(`${rel(F.f)}:${lineOf(F,n)} ${n.expression.text}`); analyze(d.F,tf,ctx,depth+1,tf.parameters[anyR].name.text,null); }
      }
      // req dentro de un objeto literal: {req, ...} se trata como pasado al helper
      for(const x of a) if(ts.isObjectLiteralExpression(x)&&ts.isIdentifier(n.expression)) for(const p of x.properties){ const v2=ts.isShorthandPropertyAssignment(p)?p.name:ts.isPropertyAssignment(p)?p.initializer:null; if(v2&&isR(v2)){ const d=resolveVal(F,n.expression.text); if(d&&fnOf(d.node)) ctx.pii.push(...findPii(d.F,fnOf(d.node),new Set())); } }
      // llamadas sin req: se sigue por si dentro hay logPiiAccess con req capturado (solo cierres locales)
    }
    ts.forEachChild(n,v);
  };
  if(fn.body) v(fn.body);
}
function findPii(F,fn,seen){ const out=[]; const id=F.f+':'+fn.pos; if(seen.has(id))return out; seen.add(id); const v=n=>{ if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)){ if(n.expression.text==='logPiiAccess') out.push(`${rel(F.f)}:${lineOf(F,n)}`); else { const d=resolveVal(F,n.expression.text); const t=d&&fnOf(d.node); if(t) out.push(...findPii(d.F,t,seen)); } } ts.forEachChild(n,v); }; v(fn); return out; }
function argInfo(F,a,ctx){
  if(ts.isArrowFunction(a)||ts.isFunctionExpression(a)){ const p=a.parameters[0]; analyze(F,a,ctx,0,p&&ts.isIdentifier(p.name)?p.name.text:null,null); if(p&&ts.isObjectBindingPattern(p.name)) ctx.opaque.push(`${rel(F.f)}:${lineOf(F,a)} req desestructurado`); return 'handler@'+lineOf(F,a); }
  if(ts.isIdentifier(a)){ const d=resolveVal(F,a.text); const t=d&&fnOf(d.node); if(t){const p=t.parameters[0]; analyze(d.F,t,ctx,0,p&&ts.isIdentifier(p.name)?p.name.text:null,null);} 
    else if(d&&d.node&&ts.isCallExpression(d.node)) return argInfo(d.F,d.node,ctx);
    return a.text; }
  if(ts.isCallExpression(a)){ // fabrica de middleware: requireRole('x'), exigirFuncion('y'), validarQuery(schema)
    const nm=a.expression.getText(F.sf); const d=ts.isIdentifier(a.expression)?resolveVal(F,a.expression.text):null; const t=d&&fnOf(d.node);
    if(t){ const vv=n=>{ if((ts.isArrowFunction(n)||ts.isFunctionExpression(n))&&n.parameters[0]&&ts.isIdentifier(n.parameters[0].name)&&/^_?req/.test(n.parameters[0].name.text)) analyze(d.F,n,ctx,0,n.parameters[0].name.text,null); ts.forEachChild(n,vv); }; vv(t); }
    return a.getText(F.sf).replace(/\s+/g,' ').slice(0,160); }
  if(ts.isArrayLiteralExpression(a)) return a.elements.map(e=>argInfo(F,e,ctx)).join('+');
  if(ts.isSpreadElement(a)) return argInfo(F,a.expression,ctx);
  return a.getText(F.sf).slice(0,60);
}
const AUTH=/^(authMiddleware|authenticate|requireAuth)/; const ROLE=/^(requirePage|deTransito|companiaPropia|bolsaPropia|requireRole|requireAnyRole|exigirFuncion|exigirAlguna|soloSinEnlace|requirePermission|exigir|tieneFuncion|verificarAccion|exigirAccion|requireSuperadmin|requireAdmin|soloCliente|autorizar|permitir|siigoExige|requiereAccion)/;
const rows=[]; const orphan=[];

for(const F of files.values()) for(const r of F.routes){
  const paths=Array.isArray(r.path)?r.path:[r.path];
  const ctx={query:new Map(),opaque:[],schemas:[],helpers:[],reqHelpers:[],pii:[],seen:new Set(),queryRejected:[]};
  const mws=r.args.map(a=>argInfo(F,a,ctx));
  // middleware de router (use sin prefijo o con prefijo que casa) declarado antes de la ruta
  const routerMws=[];
  for(const u of F.uses) if(u.routerVar===r.routerVar&&!u.mountedRouter&&u.pos<r.pos){ if(u.prefix&&!(paths[0]||'').startsWith(u.prefix))continue; for(const a of u.args) routerMws.push({txt:argInfo(F,a,ctx),line:u.line}); }
  const cs=chains(key(F.f,r.routerVar));
  const mountMws=[]; for(const c of cs) for(const m of c.via){ const T=files.get(m.file); for(const u of T.uses) if(u.pos<m.pos&&!u.mountedRouter&&u.routerVar===m.parent.split('#')[1]&&(u.prefix===''||m.prefix.startsWith(u.prefix))&&T.f!==path.join(SRC,'app.ts')) for(const a of u.args) mountMws.push({txt:argInfo(T,a,ctx),line:u.line,file:rel(T.f)}); }
  const allMw=[...routerMws.map(x=>x.txt),...mountMws.map(x=>x.txt),...mws];
  for(const p of paths){
    const base=cs.length?cs.map(c=>c.prefix):[null];
    if(!cs.length) orphan.push(`${rel(F.f)}:${r.line} ${r.method} ${p}`);
    const uniq=[...new Set(base)];
    for(const b of uniq){
      const full=(b??'[SIN-MONTAJE]')+(p===null?`{${r.pathText}}`:p==='/'?'':p);
      const pp=[...new Set((String(p).match(/:[A-Za-z_][A-Za-z0-9_]*/g)||[]).map(x=>x.slice(1)))];
      const pb=[...new Set((String(b||'').match(/:[A-Za-z_][A-Za-z0-9_]*/g)||[]).map(x=>x.slice(1)))];
      rows.push({method:r.method,full:full||'/',file:rel(F.f),line:r.line,pathParams:[...new Set([...pb,...pp])],unresolvedPath:p===null,query:Object.fromEntries(ctx.query),opaque:[...new Set(ctx.opaque)],schemas:[...new Set(ctx.schemas)],helpers:[...new Set([...ctx.helpers])],reqHelpers:[...new Set(ctx.reqHelpers)],pii:[...new Set(ctx.pii)],
        auth:allMw.some(x=>AUTH.test(x)),authz:allMw.filter(x=>ROLE.test(x)),mw:allMw,routerMw:routerMws,queryRejected:ctx.queryRejected,wrap:cs.flatMap(c=>c.via.map(m=>m.wrap)).filter(Boolean)[0]||null});
    }
  }
}
// El app.ts: rutas directas ya entran con prefijo ''
rows.sort((a,b)=>a.full.localeCompare(b.full)||a.method.localeCompare(b.method));
fs.writeFileSync(path.join(OUT,'rutas.json'),JSON.stringify(rows,null,1));
const count=(f)=>rows.filter(f).length;
const byM={};for(const r of rows)byM[r.method]=(byM[r.method]||0)+1;
const qlines=[];for(const F of files.values()){const v=n=>{if(ts.isPropertyAccessExpression(n)&&n.name.text==='query'&&ts.isIdentifier(n.expression)&&/^_?(req|request|r)$/.test(n.expression.text))qlines.push(rel(F.f)+':'+lineOf(F,n));ts.forEachChild(n,v)};v(F.sf)}
const missQ=qlines.filter(x=>!TOUCHED.has(x));
fs.writeFileSync(path.join(OUT,'query-lines.json'),JSON.stringify({total:qlines.length,missQ},null,1));
console.log('nodos req.query en AST:',qlines.length,' atribuidos a una ruta:',qlines.length-missQ.length,' sin atribuir:',missQ.length);missQ.forEach(x=>console.log('   ',x));
console.log('archivos .ts analizados:',files.size);
console.log('archivos con routes registradas:',[...files.values()].filter(F=>F.routes.length).length);
console.log('filas de ruta (ruta+montaje):',rows.length,JSON.stringify(byM));
console.log('GET total:',count(r=>r.method==='GET'),' GET con path param:',count(r=>r.method==='GET'&&r.pathParams.length),' GET con query:',count(r=>r.method==='GET'&&Object.keys(r.query).length),' GET con path o query:',count(r=>r.method==='GET'&&(r.pathParams.length||Object.keys(r.query).length||r.opaque.length)));
console.log('sin montaje:',orphan.length);orphan.slice(0,40).forEach(x=>console.log('  ',x));
console.log('path no literal:',count(r=>r.unresolvedPath));rows.filter(r=>r.unresolvedPath).slice(0,20).forEach(r=>console.log('  ',r.file+':'+r.line,r.full));
console.log('candidatos con objeto no-router:',unresolvedCandidates.length);unresolvedCandidates.slice(0,30).forEach(x=>console.log('  ',x));
console.log('query opaca:',count(r=>r.opaque.length));rows.filter(r=>r.opaque.length).forEach(r=>console.log('  ',r.method,r.full,JSON.stringify(r.opaque)));

// ---- clasificacion (HU #13986): cada fila cae en un grupo con hallazgo o en una categoria sin PII. Residual = 0 o se declara.
const G=[
 ['G1',/^GET \/api\/privacy\/preview\/:docNumber$/],
 ['G2',/^GET \/api\/flito\/(soat|impuestos|tramites)$/],
 ['G3',/^GET (\/api\/flito\/(derechos|logistica)|\/api\/finanzas\/(reporte-costos(\/consolidado|\/facturacion-electronica)?|gastos-diarios))$/],
 ['G4',/^GET \/api\/(vehicles|drivers|laft\/counterparties|users|users\/export|users\/resumen)$/],
 ['G5',/^GET \/api\/(tramites|fleet\/vehicles|rndc\/(tenedores|propietarios-carga|destinatarios-carga)|drive\/search)$/],
 ['G6',/^(GET \/api\/vehicles\/:vin\/(historial|certificado)|POST \/api\/vehicles\/:vin\/historial\/sync|GET \/api\/flito\/derechos\/candidatos\/:placa)$/],
 ['G7',/^GET \/api\/(public\/drive\/cuentas-archivo\/:dir\/:token\/:filename|drive\/cuentas-archivo\/:dir\/:filename)$/],
 ['G8',/^(GET|POST) \/api\/(tramite-portal\/:token(\/.*)?|validacion-identidad\/(info|completar)\/:token)$/],
 ['G9',/^GET \/api\/(public\/tramite-verificar(\/qr-png\/:token)?|rndc\/public\/manifiestos\/(qr|qr-png)\/:token|drivers\/checklists\/qr\/:token)$/],
 ['G10',/^GET \/api\/files$/],
];
const OPAQUE_P=new Set('accId actaId actionId alarmaId asignacionId bolsaId clienteId companiaId counterpartyId docId documentoId estandarId facturaId fileId firmanteId hallazgoId id itemId jobId loteId movimientoId objId opId partId periodId soporteId tramiteId userId viajeId wpId keyHash resourceId'.split(' '));
const CAT_P=new Set('filename anio mes trimestre code codigo departamento fuente listCode modulo pais proveedor resource tipo tipologia'.split(' '));
const OPAQUE_Q=new Set('causalId clienteId clienteIds companiaId companias conductorId counterpartyId cursor ids loteId partId proveedores resourceId routeId systemId titularUserId tramiteId tramiteIds userId vehicleId vehiculoId woId'.split(' '));
const BENIGN_Q=new Set('accion actas activo alerta ambiente anio aplicaA aplicado aprobadoDesde aprobadoHasta asociacion autogestion breachOnly causal ciudades cilindraje clase combustible conAdvertencia conDiferencias conStockBajo concepto creadoDesde creadoHasta days decision depto desde dias documentacionCompleta entidad estado estadoFacturacion estados estancado etapa fecha fechaDesde fechaHasta finalidad folder from fuente gestion gravedad hasta impuesto incluirBajas incluirFacturables incluirInactivos incluirResueltas incluirXml kind lat limit limite linea liquidadoPendientePago listCode lng marca match_blocked mes min modalidadEntrada modulo motivo municipio next_review_at_until offset orden organismo organismos origenes page pageSize pagadoDesde pagadoHasta pagina pais periodo porPagina proceso proximas publicado puertas radioKm resource resourceTipo resultado risk risk_level rol rolCodigo semaforo sinCausal sinManifiesto soat soloActivos soloBajas soloHabilitados solicitadoDesde solicitadoHasta status tipo tipoTramite tipos to transitos umbralAlcohol vencidos view vigencia vigente vigentes year zona'.split(' '));
const TEXT_OK=/^GET \/api\/(maintenance\/jobs|parts|rndc\/catalogos\/(municipios|productos)|siigo\/ciudades\/buscar|siigo\/productos|flito\/comparendos\/registros)$|^POST \/api\/flito\/comparendos\/registros\/(buscar|export)$/;
const cls={},res=[];
for(const r of rows){ const k=r.method+' '+r.full; const g=G.find(([,re])=>re.test(k));
 if(g){r.grupo=g[0];cls[g[0]]=(cls[g[0]]||0)+1;continue;}
 const qs=Object.keys(r.query); const pOk=r.pathParams.every(p=>OPAQUE_P.has(p)||CAT_P.has(p));
 // `filename` solo se acepta como catalogo fuera de G7: en ocr-extracted lo genera el servidor (`${tipo}_${Date.now()}.pdf`, ocr-docs.routes.ts:313).
 const qOk=qs.every(q=>OPAQUE_Q.has(q)||BENIGN_Q.has(q)||(q==='q'&&TEXT_OK.test(k)));
 if(!pOk||!qOk){res.push(k+' P='+r.pathParams+' Q='+qs);r.grupo='RESIDUAL';continue;}
 let c;
 if(!r.pathParams.length&&!qs.length) c='S1-sin-path-ni-query';
 else if(qs.includes('q')) c='S4-texto-libre-catalogo-o-numero';
 else if(r.pathParams.some(p=>CAT_P.has(p))&&!r.pathParams.some(p=>OPAQUE_P.has(p))&&!qs.length) c='S3-solo-catalogo-en-path';
 else c='S2-ids-opacos-y-filtros-no-identificantes';
 r.grupo=c;cls[c]=(cls[c]||0)+1;
}
fs.writeFileSync(path.join(OUT,'rutas.json'),JSON.stringify(rows,null,1));
const gm=(pred)=>rows.filter(pred).length; const isG=/^G\d+$/;
console.log('--- clasificacion');Object.keys(cls).sort().forEach(k=>console.log(k,cls[k],' GET:',gm(r=>r.grupo===k&&r.method==='GET')));
console.log('total con hallazgo:',gm(r=>isG.test(r.grupo)),' GET:',gm(r=>isG.test(r.grupo)&&r.method==='GET'),' no-GET:',gm(r=>isG.test(r.grupo)&&r.method!=='GET'));
console.log('total sin hallazgo:',gm(r=>/^S/.test(r.grupo)),' GET:',gm(r=>/^S/.test(r.grupo)&&r.method==='GET'));
console.log('residual:',res.length);res.forEach(x=>console.log('  ',x));
