import { execFileSync } from 'node:child_process';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

const mode = process.argv[2];
if (!['inspect', 'apply'].includes(mode)) throw new Error('Choose inspect or apply');
const eventSlug = 'code2create-7';
const url = 'https://realtime.c2c.sh';
const venueKeys = ["attendance.session.manage","attendance.station.manage","attendance.venue_check_in.read","attendance.venue_check_in.record","attendance.credential.enrol","attendance.credential.rebind","attendance.credential.suspend","attendance.badge.issue","attendance.badge.replace","attendance.history.read","attendance.presence.reconcile","attendance.remedy.read","attendance.remedy.open","attendance.remedy.decide","attendance.roll_call.read","attendance.roll_call.start","attendance.roll_call.close","attendance.manual_sheet.read","attendance.manual_sheet.enter","attendance.manual_sheet.source.read"];
const boardKeys = ['attendance.manual_sheet.verify', 'attendance.export.identifiable', 'attendance.venue_check_in.override_identity', 'attendance.venue_check_in.reverse', 'attendance.badge.revoke', 'attendance.plan.publish'];
const bundleVersionId = 'hs7hj39qbh5zfhev5rw8xr00r98dpe9f';
const key = execFileSync('az', ['keyvault', 'secret', 'show', '--vault-name', 'kv-c2c-prod-b88416', '--name', 'convex-admin-key', '--query', 'value', '--output', 'tsv'], { encoding: 'utf8' }).trim();
const env = { ...process.env, CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: key, CONVEX_DEPLOYMENT: '' };
function read(source, component) {
  try {
    return JSON.parse(execFileSync('pnpm', ['exec', 'convex', 'run', '--inline-query', source, ...(component ? ['--component', component] : [])], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) { throw new Error(String(error.stderr ?? error.message).replaceAll(key, '[redacted]')); }
}
function snapshot() {
  return read(`const now=Date.now();
    const e=await ctx.db.query('events').withIndex('by_slug',q=>q.eq('slug',${JSON.stringify(eventSlug)})).unique();
    if(!e?.endsAt || e.endsAt<=now)throw new Error('Active event required');
    const people=[];
    for(const role of ['sc','board']){
      const rows=await ctx.db.query('eventRoles').withIndex('by_event_role_status',q=>q.eq('eventId',e._id).eq('role',role).eq('status','active')).take(501);
      if(rows.length>500)throw new Error('Role query truncated');
      for(const r of rows){
        if(r.validFrom>now || (r.validUntil!==undefined && r.validUntil<=now))continue;
        const p=await ctx.db.get(r.personId),s=await ctx.db.get(r.eventAccessSubjectId);
        if(p?.status!=='active'||s?.status!=='active')continue;
        const all=await ctx.db.query('permissionGrants').withIndex('by_person_status',q=>q.eq('eventId',e._id).eq('personId',p._id).eq('status','active')).take(1001);
        if(all.length>1000)throw new Error('Grant query truncated');
        const keys=all.filter(g=>g.eventAccessSubjectId===s._id&&g.validFrom<=now&&(g.validUntil===undefined||g.validUntil>now)&&g.scopeType==='event').map(g=>g.permissionKey);
        people.push({id:p._id,name:p.displayName,role,accessVersion:s.accessVersion,validUntil:Math.min(e.endsAt,r.validUntil??e.endsAt),keys});
      }
    }
    const stations=await ctx.db.query('attendanceStations').withIndex('by_event_status',q=>q.eq('eventId',e._id)).take(501);
    if(stations.length>500)throw new Error('Station query truncated');
    return {checkedAt:new Date(now).toISOString(),people,stationCount:stations.length};`);
}
function missing(p, keys) { return keys.filter(k=>!p.keys.includes(k)); }
function summary(s) {
  return {checkedAt:s.checkedAt,sc:s.people.filter(p=>p.role==='sc').length,board:s.people.filter(p=>p.role==='board').length,stationCount:s.stationCount,missing:s.people.map(p=>({id:p.id,name:p.name,role:p.role,keys:missing(p,[...venueKeys,...(p.role==='board'?boardKeys:[])])})).filter(p=>p.keys.length)};
}
async function main() {
  const before=snapshot();
  console.log(JSON.stringify({before:summary(before)}));
  if(mode==='inspect')return;
  const email='technicaldirector.acmvit@gmail.com';
  const operator=read(`return await ctx.db.query('people').withIndex('by_verified_email',q=>q.eq('verifiedEmail',${JSON.stringify(email)})).unique();`);
  if(operator?.status!=='active')throw new Error('Active organizer required');
  const identity=read(`const u=await ctx.db.get(${JSON.stringify(operator.authUserId)});const s=await ctx.db.query('session').withIndex('userId',q=>q.eq('userId',${JSON.stringify(operator.authUserId)})).take(50);return {email:u?.email,verified:u?.emailVerified,sessionId:s.find(s=>s.expiresAt>Date.now())?._id};`,'betterAuth');
  if(identity.email!==email||!identity.verified||!identity.sessionId)throw new Error('Verified current organizer session required');
  const client=new ConvexHttpClient(url);
  client.setAdminAuth(key,{subject:operator.authUserId,email,sessionId:identity.sessionId,issuer:url,tokenIdentifier:`${url}|${operator.authUserId}`});
  for(const target of summary(before).missing){
    const p=snapshot().people.find(p=>p.id===target.id&&p.role===target.role);
    if(!p)throw new Error('Target role changed; inspect again');
    if(missing(p,venueKeys).length){
      const args={eventSlug,targetPersonId:p.id,bundleVersionId,bindings:[],validUntil:p.validUntil};
      const preview=await client.query(makeFunctionReference('permissionBundles:previewApplication'),args);
      if(preview.grants.length!==venueKeys.length||preview.grants.some(g=>!venueKeys.includes(g.permissionKey)||g.scopeType!=='event'))throw new Error('Unexpected venue bundle permissions');
      const result=await client.mutation(makeFunctionReference('permissionBundles:apply'),{...args,expectedAccessVersion:preview.expectedAccessVersion,previewChecksum:preview.previewChecksum,reason:'Organizer requested check-in workflow access for every active SC and Board account.',clientOperationId:`checkin-venue-20260906-${p.id}`});
      console.log(JSON.stringify({person:p.id,role:p.role,venue:result}));
    }
    if(p.role==='board'){
      const fresh=snapshot().people.find(x=>x.id===p.id&&x.role==='board');
      if(!fresh)throw new Error('Board role changed');
      const keys=missing(fresh,boardKeys);
      if(keys.length){
        const result=await client.mutation(makeFunctionReference('access:grantBatch'),{eventSlug,targetPersonId:p.id,grants:keys.map(permissionKey=>({permissionKey,scopeType:'event'})),validUntil:fresh.validUntil,expectedAccessVersion:fresh.accessVersion,reason:'Match existing Board check-in approval and override permissions, as requested by the organizer.',clientOperationId:`checkin-board-20260906-${p.id}`});
        console.log(JSON.stringify({person:p.id,board:result}));
      }
    }
  }
  const after=summary(snapshot());
  console.log(JSON.stringify({after,verified:after.missing.length===0}));
  if(after.missing.length)throw new Error('Some role accounts still lack check-in permissions');
}
main().catch(error=>{console.error(String(error.message).replaceAll(key,'[redacted]'));process.exitCode=1;});
