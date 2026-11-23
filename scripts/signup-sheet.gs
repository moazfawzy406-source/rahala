// Paste into the Apps Script project attached to the private Rahala signup Sheet.
// Set Script Property RAHALA_SIGNUP_HMAC with the same secret as the Worker.
// Deploy as a Web app, execute as owner, access Anyone. The Sheet itself stays private.
// Also set Script Property RAHALA_SIGNUP_SHEET_ID to the private Sheet ID.
function doPost(e) {
  const output = value => ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
  try {
    if (!e || !e.postData || e.postData.contents.length > 40000) return output({ok:false});
    const body=JSON.parse(e.postData.contents), secret=PropertiesService.getScriptProperties().getProperty('RAHALA_SIGNUP_HMAC');
    if(!secret || typeof body.timestamp!=='string' || !/^\d{13}$/.test(body.timestamp) || Math.abs(Date.now()-Number(body.timestamp))>300000 || typeof body.nonce!=='string' || !/^[a-f0-9-]{36}$/.test(body.nonce) || typeof body.payload!=='string' || typeof body.signature!=='string' || !/^[a-f0-9]{64}$/.test(body.signature)) return output({ok:false});
    const signed=body.timestamp+'\n'+body.nonce+'\n'+body.payload;
    const expected=Utilities.computeHmacSha256Signature(signed,secret,Utilities.Charset.UTF_8).map(x=>(x&255).toString(16).padStart(2,'0')).join('');
    let mismatch=0;for(let i=0;i<64;i++)mismatch|=expected.charCodeAt(i)^body.signature.charCodeAt(i);if(mismatch)return output({ok:false});
    const events=JSON.parse(body.payload);if(!Array.isArray(events)||!events.length||events.length>20)return output({ok:false});
    const keys=['eventId','userId','name','username','signupTime','recoveryEnabled'].sort().join(',');
    if(!events.every(x=>x&&Object.keys(x).sort().join(',')===keys&&typeof x.eventId==='string'&&/^signup_[a-f0-9-]{36}$/.test(x.eventId)&&typeof x.userId==='string'&&/^usr_[a-f0-9-]{36}$/.test(x.userId)&&typeof x.name==='string'&&x.name.length<=120&&typeof x.username==='string'&&x.username.length<=40&&typeof x.signupTime==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x.signupTime)&&x.recoveryEnabled===true))return output({ok:false});
    const lock=LockService.getScriptLock();if(!lock.tryLock(15000))return output({ok:false});
    try {
      const cache=CacheService.getScriptCache();if(cache.get(body.nonce))return output({ok:false});
      const sheet=SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('RAHALA_SIGNUP_SHEET_ID')).getSheetByName('Signups');if(!sheet)return output({ok:false});
      const last=sheet.getLastRow(), known=new Set(last>1?sheet.getRange(2,1,last-1,1).getValues().flat():[]);
      const safe=v=>/^[\s]*[=+\-@]/.test(v)?"'"+v:v;
      const rows=[];for(const x of events){if(!known.has(x.eventId)){rows.push([x.eventId,x.userId,safe(x.name),safe(x.username),x.signupTime,'Yes']);known.add(x.eventId);}}
      if(rows.length){const range=sheet.getRange(last+1,1,rows.length,6);range.setNumberFormat('@');range.setValues(rows);SpreadsheetApp.flush();}
      cache.put(body.nonce,'used',600);
      return output({ok:true,eventIds:events.map(x=>x.eventId)});
    } finally {lock.releaseLock();}
  } catch {return output({ok:false});}
}
