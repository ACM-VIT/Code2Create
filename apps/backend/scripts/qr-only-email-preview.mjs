import { execFileSync } from 'node:child_process';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import QRCode from 'qrcode';
import { signServiceBody } from '../../../packages/domain/src/intelligenceSigning.ts';
import { participantEmailSendProtocolVersion, participantEmailSendSignatureContext } from '../../../packages/domain/src/email.ts';

const mode=process.argv[2];
if(!['inspect','publish','send'].includes(mode))throw new Error('Choose inspect, publish, or send');
const key=execFileSync('az',['keyvault','secret','show','--vault-name','kv-c2c-prod-b88416','--name','convex-admin-key','--query','value','--output','tsv'],{encoding:'utf8'}).trim();
const env={...process.env,CONVEX_SELF_HOSTED_URL:'https://realtime.c2c.sh',CONVEX_SELF_HOSTED_ADMIN_KEY:key,CONVEX_DEPLOYMENT:''};
function cli(args){try{return execFileSync('pnpm',['exec','convex',...args],{cwd:new URL('..',import.meta.url),env,encoding:'utf8',maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});}catch(error){throw new Error(String(error.stderr??error.message).replaceAll(key,'[redacted]'));}}
function readQuery(source,component){return JSON.parse(cli(['run','--inline-query',source,...(component?['--component',component]:[])]));}
const email='technicaldirector.acmvit@gmail.com';
const operator=readQuery(`return await ctx.db.query('people').withIndex('by_verified_email',q=>q.eq('verifiedEmail',${JSON.stringify(email)})).unique();`);
if(operator?.status!=='active')throw new Error('Active organizer required');
const identity=readQuery(`const u=await ctx.db.get(${JSON.stringify(operator.authUserId)});const sessions=await ctx.db.query('session').withIndex('userId',q=>q.eq('userId',${JSON.stringify(operator.authUserId)})).take(50);return {email:u?.email,verified:u?.emailVerified,sessionId:sessions.find(s=>s.expiresAt>Date.now())?._id};`,'betterAuth');
if(identity.email!==email||!identity.verified||!identity.sessionId)throw new Error('Verified current organizer session required');
const client=new ConvexHttpClient(env.CONVEX_SELF_HOSTED_URL);
client.setAdminAuth(key,{subject:operator.authUserId,email,sessionId:identity.sessionId,issuer:env.CONVEX_SELF_HOSTED_URL,tokenIdentifier:`${env.CONVEX_SELF_HOSTED_URL}|${operator.authUserId}`});
const eventSlug='code2create-7';
const ref=name=>makeFunctionReference(`communicationsPolicyConfiguration:${name}`);
let current=await client.query(ref('current'),{eventSlug});
const template=current.publishedPolicy.policy.emailTemplates.find(t=>t.templateKey==='external_event_pass');
if(!template)throw new Error('Missing external pass template');
if(mode==='inspect'){
 console.log(JSON.stringify({version:current.publishedPolicy.version,eventVersion:current.eventVersion,draft:current.draftPolicy?{id:current.draftPolicy.id,version:current.draftPolicy.version}:null,canPublish:current.canPublish,template,venue:current.publishedPolicy.policy.venueName}));
 process.exit(0);
}
if(mode==='publish'){
 if(current.draftPolicy)throw new Error('Existing communications draft; do not overwrite');
 const html=template.html.replace(/<div><a href="\{\{portal_url\}\}"[^>]*>Open participant portal<\/a><\/div>\s*<br\s*\/><br\s*\/>/gu,'');
 const text=template.text.replace(' Event support is available through {{portal_url}}.','');
 if(/wallet|portal/i.test(html+text)||!html.includes('cid:event-pass-qr.png')||html===template.html)throw new Error('Unexpected portal markup; inspect before publishing');
 const policy={...current.publishedPolicy.policy,emailTemplates:current.publishedPolicy.policy.emailTemplates.map(t=>t.templateKey==='external_event_pass'?{...t,html,text}:t)};
 const reason='Remove the participant portal button and portal support reference from the external event-pass email as requested. Preserve the inline QR, event details, Discord links and all other communications.';
 const draft=await client.mutation(ref('createDraft'),{eventSlug,policy,expectedEventVersion:current.eventVersion,reason,clientOperationId:'external-pass-no-portal-draft-20260906'});
 const validation=await client.query(ref('validateDraft'),{eventSlug,draftPolicyId:draft.policyVersionId});
 if(!validation.valid)throw new Error(JSON.stringify(validation));
 const fresh=await client.query(ref('current'),{eventSlug});
 const published=await client.mutation(ref('publish'),{eventSlug,draftPolicyId:draft.policyVersionId,expectedDraftChecksum:draft.checksum,expectedEventVersion:fresh.eventVersion,reason,clientOperationId:'external-pass-no-portal-publish-20260906'});
 current=await client.query(ref('current'),{eventSlug});
 if(JSON.stringify(current.publishedPolicy.policy)!==JSON.stringify(policy))throw new Error('Published policy differs from requested policy');
 console.log(JSON.stringify({published,validation,verified:true}));
 process.exit(0);
}
if(/wallet|portal/i.test(template.html+template.text))throw new Error('Publish QR-only email without portal links before sending');
const context=readQuery(`const e=await ctx.db.query('events').withIndex('by_slug',q=>q.eq('slug','code2create-7')).unique();return {name:e.name,timezone:e.timezone,startsAt:e.startsAt};`);
const variables={participant_name:'Ishaan Samdani',team_name:'ACM-VIT',event_name:context.name,event_start:new Intl.DateTimeFormat('en-IN',{timeZone:context.timezone,day:'numeric',month:'long',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(context.startsAt)),venue_name:current.publishedPolicy.policy.venueName,pass_reference:'C2C-0000-0000'};
const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function render(source,html=false){return source.replace(/\{\{\s*([a-z_]+)\s*\}\}/g,(_,name)=>{if(!(name in variables))throw new Error(`Unknown placeholder ${name}`);return html?escape(variables[name]):variables[name];});}
let html=render(template.html,true);
const attachments=[];
if(template.assetBundleId){
 const assets=readQuery(`const bundle=await ctx.db.get(${JSON.stringify(template.assetBundleId)});return await Promise.all(bundle.assets.map(async a=>({...a,url:await ctx.storage.getUrl(a.storageId)})));`);
 for(const asset of assets){
  const response=await fetch(asset.url);if(!response.ok)throw new Error('Asset download failed');
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length!==asset.byteCount)throw new Error('Asset size mismatch');
  html=html.replaceAll(`cid:${asset.fileName}`,`cid:${asset.contentId}`);
  attachments.push({filename:asset.fileName,contentType:asset.contentType,contentBase64:bytes.toString('base64'),disposition:asset.disposition,...(asset.disposition==='inline'?{contentId:asset.contentId}:{})});
 }
}
const qr=await QRCode.toBuffer('Code2Create email preview. Not valid for admission.',{type:'png',width:480,margin:2,errorCorrectionLevel:'M',color:{dark:'#19070fff',light:'#ffffffff'}});
attachments.push({filename:'event-pass-qr.png',contentType:'image/png',contentBase64:qr.toString('base64'),disposition:'inline',contentId:'event-pass-qr.png'});
const request={protocolVersion:participantEmailSendProtocolVersion,provider:'aws_ses',requestId:`external-qr-only-ishaan-preview-20260906-policy${current.publishedPolicy.version}`,to:'samdani.ishaan@gmail.com',subject:render(template.subject),text:render(template.text),html,headers:[],attachments};
if(/test/i.test(request.subject)||/wallet/i.test(request.html+request.text)||request.to!=='samdani.ishaan@gmail.com')throw new Error('Preview scope mismatch');
const ids=new Set(attachments.filter(a=>a.disposition==='inline').map(a=>a.contentId));
for(const match of html.matchAll(/src=["']cid:([^"']+)["']/g)){if(!ids.has(match[1]))throw new Error(`Missing inline image ${match[1]}`);}
const serviceUrl=cli(['env','get','EMAIL_SERVICE_URL']).trim();
const secret=cli(['env','get','EMAIL_SEND_INGRESS_SECRET']).trim();
if(!serviceUrl.startsWith('https://')||secret.length<32)throw new Error('Email service is not configured');
const body=JSON.stringify(request),timestamp=String(Date.now());
const signature=await signServiceBody({context:participantEmailSendSignatureContext,secret,timestamp,body});
const response=await fetch(new URL('/send',serviceUrl),{method:'POST',headers:{'content-type':'application/json','x-c2c-signature':signature,'x-c2c-timestamp':timestamp},body,signal:AbortSignal.timeout(30000)});
const result=await response.json();
console.log(JSON.stringify({to:request.to,subject:request.subject,status:response.status,result,inlineImages:ids.size}));
if(!response.ok||result.status!=='accepted')process.exitCode=1;
