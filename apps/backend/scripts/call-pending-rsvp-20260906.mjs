import { execFileSync } from 'node:child_process';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

const mode = process.argv[2];
if (!['inspect', 'call', 'repeat', 'final-repeat'].includes(mode)) throw new Error('Choose inspect, call, repeat, or final-repeat');
const finalReminderOffers = new Set([
  'jx7cq614gesvagyvjy9gwzedy98dt5m8', 'jx73zf2kx8cdfv6w3gyk5yn6658dtqdy',
  'jx78p4kykvcn0a17p546r5dzdx8dvtsp', 'jx7asn1bhge2dbsb2c0gm3kzms8dvdj5',
  'jx79am14qh58jp8b0jndc7bjzs8dt7s2', 'jx75w7q3hnqn369jeqvanb8s8d8dv9yn',
  'jx7dzddn9hjfmnq98by7yrpzdh8dvbh9', 'jx74sap89nnydpv6ypadysbbe98dtpeb',
  'jx79pcxh6m4cnwt76m2y36hwgs8dtjfn', 'jx72rhhy9bqwrxakxyqyy9zqz58dtcs3',
]);
const authorizedOffers = new Set([
  'jx7d87rv82kzt6403b134833ax8dv15j', 'jx75w7q3hnqn369jeqvanb8s8d8dv9yn', 'jx7cgdar42apk8zf424dyvqrrx8dvjz5',
  'jx73kzqr81rmky0amp5pax7nw98dt78n', 'jx7ead9qa9j2c6ncgrntfg22618dv3z1', 'jx73zf2kx8cdfv6w3gyk5yn6658dtqdy',
  'jx7asn1bhge2dbsb2c0gm3kzms8dvdj5', 'jx79ktv2gy1e6kz3yrw21ph5bn8dvg54', 'jx74a7xq3jyhmx5pfspwehf5ds8dv54c',
  'jx71spe3crcb13m92prszq1pzd8dv0fk', 'jx76nbh8119g4h46g63nhr9sxs8dvrf7', 'jx7cq614gesvagyvjy9gwzedy98dt5m8',
  'jx7dzddn9hjfmnq98by7yrpzdh8dvbh9', 'jx72rhhy9bqwrxakxyqyy9zqz58dtcs3', 'jx782hgf9hsm4114dr9ar8791s8dtn1b',
  'jx73b9agsznan1sgs0w0task3x8dvr3s', 'jx715vxb5nd8bxwj5d9v085wvn8dten8', 'jx78p4kykvcn0a17p546r5dzdx8dvtsp',
  'jx7cdx52jz4y4mhje2zefjys6h8dt8d7', 'jx772kks8g3fvrzmf7sxfgtv3s8dvsx2', 'jx739fhrmbngdb109e585cbdz18dt22e',
  'jx79am14qh58jp8b0jndc7bjzs8dt7s2', 'jx74sap89nnydpv6ypadysbbe98dtpeb', 'jx7706es0x9m37dxyj2m3zm5t18dtxnj',
  'jx78kdsc2nx0wymvt82hs286qh8dtvq8', 'jx79pcxh6m4cnwt76m2y36hwgs8dtjfn', 'jx77447c0dr8t9ssf93424apxn8dtdfj',
]);
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
    const offers=await ctx.db.query('admissionOffers').withIndex('by_event_state_expiry',q=>q.eq('eventId',e._id).eq('state','offered')).take(1001);
    if(offers.length>1000)throw new Error('Too many offers');
    const teams=[];for(const o of offers){const a=await ctx.db.get(o.applicationId);const t=await ctx.db.get(o.teamId);
      if(a?.currentOfferId!==o._id||a.state!=='offer_sent'||!t?.activeVitMemberCount)continue;
      const p=await ctx.db.get(a.submittedProjectVersionId);const profile=await ctx.db.query('participantProfiles').withIndex('by_membership',q=>q.eq('membershipId',p.lockedLeadMembershipId)).unique();
      const c=await ctx.db.query('outboundCallDeliveries').withIndex('by_source',q=>q.eq('eventId',e._id).eq('sourceType','admission_offer_reminder').eq('sourceId',o._id).eq('purpose','participant_event_update')).order('desc').first();
      teams.push({team:t.name,offerId:o._id,phoneAvailable:Boolean(profile?.phone),expiresAt:o.expiresAt,call:c?{id:c._id,state:c.state,attemptCount:c.attemptCount,providerAccepted:Boolean(c.providerCallId),error:c.providerErrorCode,createdAt:c.createdAt,updatedAt:c.updatedAt}:null});}
    return {checkedAt:new Date().toISOString(),teams};`);
}
const before = snapshot();
console.log(JSON.stringify({ before }));
if (mode === 'inspect') process.exit(0);
if (before.teams.length > 27) throw new Error('Pending cohort exceeds authorized 27 teams');
const email = 'technicaldirector.acmvit@gmail.com';
const operator = read(`return await ctx.db.query('people').withIndex('by_verified_email',q=>q.eq('verifiedEmail',${JSON.stringify(email)})).unique();`);
if (operator?.status !== 'active') throw new Error('Active organizer required');
const identity = read(`const u=await ctx.db.get(${JSON.stringify(operator.authUserId)});const s=await ctx.db.query('session').withIndex('userId',q=>q.eq('userId',${JSON.stringify(operator.authUserId)})).take(50);return {email:u?.email,verified:u?.emailVerified,sessionId:s.find(s=>s.expiresAt>Date.now())?._id};`, 'betterAuth');
if (identity.email !== email || !identity.verified || !identity.sessionId) throw new Error('Verified current organizer session required');
const client = new ConvexHttpClient(url);
client.setAdminAuth(key, { subject: operator.authUserId, email, sessionId: identity.sessionId, issuer: url, tokenIdentifier: `${url}|${operator.authUserId}` });
for (const team of before.teams) {
  if (!authorizedOffers.has(team.offerId)) continue;
  if (mode === 'final-repeat' && !finalReminderOffers.has(team.offerId)) continue;
  if (mode === 'repeat' || mode === 'final-repeat') {
    if (!team.call || !['completed', 'busy', 'no_answer', 'failed'].includes(team.call.state)) {
      console.log(JSON.stringify({ team: team.team, skipped: 'No definite previous call outcome' }));
      continue;
    }
    try {
      await client.mutation(makeFunctionReference('admissionOfferCalls:repeat'), {
        eventSlug: 'code2create-7', offerId: team.offerId, previousDeliveryId: team.call.id,
        reason: mode === 'final-repeat'
          ? 'Organizer requested one more phone reminder for the remaining 10 internal teams before the 1 PM IST RSVP deadline.'
          : 'Organizer requested another phone reminder for the 27 unanswered internal teams before the 1 PM IST RSVP deadline.',
        clientOperationId: `repeat-rsvp-call-20260906-${mode === 'final-repeat' ? 'round3' : 'round2'}-${team.offerId}`,
      });
      console.log(JSON.stringify({ team: team.team, repeatRequested: true }));
    } catch (error) {
      console.log(JSON.stringify({ team: team.team, error: String(error.message).replaceAll(key, '[redacted]') }));
    }
    continue;
  }
  if (team.call && !['pending', 'retry_wait'].includes(team.call.state)) {
    console.log(JSON.stringify({ team: team.team, skippedExistingCall: team.call.state }));
    continue;
  }
  try {
    await client.mutation(makeFunctionReference('admissionOfferCalls:sendNow'), {
      eventSlug: 'code2create-7', offerId: team.offerId,
      clientOperationId: `pending-rsvp-call-20260906-1120-${team.offerId}`,
    });
    console.log(JSON.stringify({ team: team.team, requested: true }));
  } catch (error) {
    console.log(JSON.stringify({ team: team.team, error: String(error.message).replaceAll(key, '[redacted]') }));
  }
}
console.log(JSON.stringify({ after: snapshot() }));
