import { execFileSync } from 'node:child_process';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

const mode = process.argv[2];
if (!['inspect', 'apply'].includes(mode)) throw new Error('Choose inspect or apply');
const url = 'https://realtime.c2c.sh';
const key = execFileSync('az', ['keyvault', 'secret', 'show', '--vault-name', 'kv-c2c-prod-b88416', '--name', 'convex-admin-key', '--query', 'value', '--output', 'tsv'], { encoding: 'utf8' }).trim();
const env = { ...process.env, CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: key, CONVEX_DEPLOYMENT: '' };
function read(source, component) {
  try {
    return JSON.parse(execFileSync('pnpm', ['exec', 'convex', 'run', '--inline-query', source, ...(component ? ['--component', component] : [])], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) { throw new Error(String(error.stderr ?? error.message).replaceAll(key, '[redacted]')); }
}
function snapshot() {
  return read(`const e=await ctx.db.query('events').withIndex('by_slug',q=>q.eq('slug','code2create-7')).unique();
    const offers=await ctx.db.query('admissionOffers').withIndex('by_event_state_expiry',q=>q.eq('eventId',e._id).eq('state','offered')).take(2001);
    if(offers.length>2000)throw new Error('Too many offers');
    const deadlines={};for(const o of offers){const d=new Date(o.expiresAt).toISOString();deadlines[d]=(deadlines[d]??0)+1;}
    return {checkedAt:new Date().toISOString(),eventId:e._id,version:e.version,startsAt:e.startsAt,closesAt:e.admissionRsvpClosesAt,reminderAt:e.admissionRsvpReminderAt,pendingTeams:offers.length,deadlines};`);
}
const before = snapshot();
console.log(JSON.stringify({ before }));
if (mode === 'inspect') process.exit(0);
const closesAt = Date.parse('2026-09-06T13:00:00+05:30');
if (closesAt <= Date.now() || closesAt > before.startsAt || closesAt < before.closesAt) throw new Error('Requested time is not a valid extension');
if (before.closesAt === closesAt) { console.log('Deadline already configured'); process.exit(0); }
if (before.reminderAt !== undefined && before.reminderAt <= Date.now()) throw new Error('Existing reminder elapsed; requires explicit schedule handling');
const email = 'technicaldirector.acmvit@gmail.com';
const operator = read(`return await ctx.db.query('people').withIndex('by_verified_email',q=>q.eq('verifiedEmail',${JSON.stringify(email)})).unique();`);
if (operator?.status !== 'active') throw new Error('Active organizer required');
const identity = read(`const u=await ctx.db.get(${JSON.stringify(operator.authUserId)});const s=await ctx.db.query('session').withIndex('userId',q=>q.eq('userId',${JSON.stringify(operator.authUserId)})).take(50);return {email:u?.email,verified:u?.emailVerified,sessionId:s.find(s=>s.expiresAt>Date.now())?._id};`, 'betterAuth');
if (identity.email !== email || !identity.verified || !identity.sessionId) throw new Error('Verified current organizer session required');
const client = new ConvexHttpClient(url);
client.setAdminAuth(key, { subject: operator.authUserId, email, sessionId: identity.sessionId, issuer: url, tokenIdentifier: `${url}|${operator.authUserId}` });
await client.mutation(makeFunctionReference('admissionRsvp:configure'), {
  eventSlug: 'code2create-7', expectedEventVersion: before.version, closesAt,
  ...(before.reminderAt !== undefined ? { reminderAt: before.reminderAt } : {}),
  reason: 'Extend the RSVP deadline to September 6, 2026, 1:00 PM IST as requested by the event organizer.',
  clientOperationId: 'extend-rsvp-20260906-1300-ist',
});
const after = snapshot();
if (after.closesAt !== closesAt) throw new Error('Deadline read-back mismatch');
console.log(JSON.stringify({ verified: true, after }));
