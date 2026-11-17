// Port of patch_bytes_slsr from tiktok-lossless-upload (buwryme), slsr method.
// Byte-exact port intent. Works on a Uint8Array, returns a Uint8Array.

const CONTAINERS = new Set(["moov","trak","mdia","minf","stbl","edts","dinf"]);
const AAC_RATES = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
const SILENT_FRAME = Uint8Array.from([33,16,4,96,140,28]);

const te = new TextEncoder();
const fourccStr = (u8,off)=>String.fromCharCode(u8[off],u8[off+1],u8[off+2],u8[off+3]);
function u32(d,o){return ((d[o]<<24)|(d[o+1]<<16)|(d[o+2]<<8)|d[o+3])>>>0;}
function u64(d,o){ // returns Number (safe for mp4 sizes)
  const hi=u32(d,o), lo=u32(d,o+4); return hi*4294967296+lo;
}
function p32(v){const b=new Uint8Array(4);b[0]=(v>>>24)&255;b[1]=(v>>>16)&255;b[2]=(v>>>8)&255;b[3]=v&255;return b;}
function p64(v){const b=new Uint8Array(8);let hi=Math.floor(v/4294967296),lo=v>>>0;b.set(p32(hi),0);b.set(p32(lo),4);return b;}
function concat(arrs){let n=0;for(const a of arrs)n+=a.length;const out=new Uint8Array(n);let p=0;for(const a of arrs){out.set(a,p);p+=a.length;}return out;}
function p32s(...vals){return concat(vals.map(p32));}
function fourccBytes(name){const b=new Uint8Array(4);const s=typeof name==="string"?name:String.fromCharCode(...name);for(let i=0;i<4;i++)b[i]=i<s.length?s.charCodeAt(i):0x20;return b;}
function box(name,payload){return concat([p32(payload.length+8),fourccBytes(name),payload]);}
function assert(c,m){if(!c)throw new Error("slsr assert: "+(m||""));}

class Box{constructor(name,data,raw,children){this.name=name;this.data=data;this.raw=raw;this.children=children;}
  clone(){return new Box(this.name,this.data,this.raw,this.children?this.children.map(c=>c.clone()):null);}}

function readHeader(d,off,available){
  assert(available>=8,"hdr");
  const size=u32(d,off);
  const header=size===1?16:8;
  assert(available>=header,"hdr2");
  const total=size===1?u64(d,off+8):(size||available);
  assert(Number.isFinite(total)&&total>=header&&total<=available,"hdr3");
  return {name:fourccStr(d,off+4),header,total,zero:size===0};
}
function parseBoxes(d,start,end,depth=0){
  assert(depth<16,"depth");
  const res=[];let pos=start;
  while(pos<end){
    const {name,header,total}=readHeader(d,pos,end-pos);
    const raw=d.subarray(pos,pos+total);
    const payload=d.subarray(pos+header,pos+total);
    const children=CONTAINERS.has(name)?parseBoxes(d,pos+header,pos+total,depth+1):null;
    // store payload copy as data
    res.push(new Box(name,payload.slice(),raw.slice(),children));
    pos+=total;
  }
  return res;
}
function serialize(item){
  if(item.children!==null) return box(item.name,concat(item.children.map(serialize)));
  if(item.raw!==null) return item.raw;
  return box(item.name,item.data);
}
function child(item,name){for(const c of item.children||[])if(c.name===name)return c;throw new Error("missing box "+name);}
function findChild(item,name){for(const c of item.children||[])if(c.name===name)return c;return null;}
function setData(item,data){item.data=data instanceof Uint8Array?data.slice():Uint8Array.from(data);item.raw=null;}
function writeInt(item,offset,width,value){
  assert(value>=0&&(width===8||value<0xFFFFFFFF),"wint");
  const data=item.data.slice();
  data.set(width===8?p64(value):p32(value),offset);
  setData(item,data);
}
function readInt(d,offset,width){return width===8?u64(d,offset):u32(d,offset);}

function descriptor(d,start,end){
  assert(start<(end??d.length),"desc");
  const tag=d[start];let pos=start+1,length=0;
  for(let i=0;i<4;i++){assert(pos<(end??d.length),"desc2");const v=d[pos++];length=length*128+(v&0x7F);if(!(v&0x80)){assert(pos+length<=(end??d.length),"desc3");return {tag,start:pos,end:pos+length};}}
  throw new Error("invalid descriptor");
}
function descriptorBytes(tag,payload){
  const length=payload.length;
  return concat([Uint8Array.from([tag,0x80|(length>>21),0x80|((length>>14)&0x7F),0x80|((length>>7)&0x7F),length&0x7F]),payload]);
}

function patchAudioDescription(stsd){
  const data=stsd.data;
  assert(data.length>=44&&u32(data,0)===0&&u32(data,4)===1,"stsd");
  const sample=data.subarray(8);
  assert(fourccStr(sample,4)==="mp4a"&&u32(sample,0)===sample.length,"mp4a");
  assert(sample[16]===0&&sample[17]===0&&sample[24]===0&&sample[25]===2,"mp4a-fields");
  const entries=parseBoxes(sample,36,sample.length);
  const esds=entries.find(e=>e.name==="esds");
  assert(esds&&!entries.some(e=>e.name==="sinf"||e.name==="wave"),"esds");
  const esdsData=esds.data;
  assert(esdsData.length>=4&&u32(esdsData,0)===0,"esds2");
  const decoder=descriptor(esdsData,4,esdsData.length);
  assert(decoder.tag===3&&decoder.end-decoder.start>=3&&esdsData[decoder.start+2]===0,"esds3");

  let rateIndex=-1;const rebuilt=[];let pos=decoder.start+3;
  while(pos<decoder.end){
    const item=descriptor(esdsData,pos,decoder.end);
    if(item.tag!==4){rebuilt.push(esdsData.subarray(pos,item.end));}
    else{
      assert(item.end-item.start>=13&&esdsData[item.start]===64,"dcfg");
      const nested=[];let np=item.start+13;
      while(np<item.end){
        const sub=descriptor(esdsData,np,item.end);
        if(sub.tag!==5){nested.push(esdsData.subarray(np,sub.end));}
        else{
          const config=esdsData.subarray(sub.start,sub.end);
          assert(rateIndex<0&&config.length>=2,"cfg");
          assert((config[0]>>3)===2&&(config[1]&127)===16,"cfg2");
          rateIndex=((config[0]&7)<<1)|(config[1]>>7);
          let bits="";for(const b of config.subarray(2))bits+=b.toString(2).padStart(8,"0");
          assert(rateIndex<AAC_RATES.length,"rate");
          assert(!bits.includes("1")||/^01010110111001010*$/.test(bits),"bits");
          const table=rateIndex.toString(2).padStart(4,"0");
          let configBits="00010"+table+"0000000000001"+table+"00000001000000000000000010000";
          let padded=configBits.padEnd(Math.ceil(configBits.length/8)*8,"0")+"00000000";
          const out=new Uint8Array(padded.length/8);
          for(let i=0;i<padded.length;i+=8)out[i/8]=parseInt(padded.slice(i,i+8),2);
          nested.push(descriptorBytes(5,out));
        }
        np=sub.end;
      }
      rebuilt.push(descriptorBytes(4,concat([esdsData.subarray(item.start,item.start+13),...nested])));
    }
    pos=item.end;
  }
  assert(rateIndex>=0,"rateIndex");
  setData(esds,concat([esdsData.subarray(0,4),descriptorBytes(3,concat([esdsData.subarray(decoder.start,decoder.start+3),...rebuilt])),esdsData.subarray(decoder.end)]));
  const replacement=box("mp4a",concat([sample.subarray(8,36),...entries.map(serialize)]));
  return {sampleRate:AAC_RATES[rateIndex],patchedStsd:concat([p32s(0,2),sample,replacement])};
}

function tableCount(item,stride){
  assert(item.data.length>=8&&u32(item.data,0)===0,"tc");
  const count=u32(item.data,4);
  assert(item.data.length===8+count*stride&&count<=5000000,"tc2");
  return count;
}
function headerFields(item){
  assert(item.data[0]===0||item.data[0]===1,"hf");
  const v1=item.data[0]===1;const isTkhd=item.name==="tkhd";
  const offset=isTkhd?(v1?28:20):(v1?24:16);
  const width=v1?8:4;
  return {offset,width,duration:readInt(item.data,offset,width),scale:isTkhd?0:u32(item.data,offset-4)};
}
function extendEdit(item,audioDuration,audioScale,movieScale,sampleRate,duration,tail){
  const edts=findChild(item,"edts");
  if(!edts){assert(Math.abs(duration-Math.round(audioDuration*movieScale/audioScale))<=1,"edit0");return tail;}
  const elst=child(edts,"elst");const data=elst.data;
  assert(data[0]===0||data[0]===1,"elst");
  const width=data[0]===1?8:4;const count=u32(data,4);const stride=2*width+4;
  assert((count===1||count===2)&&data.length===8+count*stride,"elst2");
  const offset=8+(count-1)*stride;
  const segment=readInt(data,offset,width);const mediaTime=readInt(data,offset+width,width);
  assert(mediaTime>=0&&u32(data,offset+2*width)===65536,"elst3");
  if(count===2){for(let i=8+width;i<8+2*width;i++)assert(data[i]===255,"elst4");assert(u32(data,8+2*width)===65536,"elst5");}
  assert(Math.abs(duration-segment-(count===2?readInt(data,8,width):0))<=1,"elst6");
  const difference=(audioDuration-mediaTime)*movieScale-segment*audioScale;
  assert(Math.abs(difference)<=Math.ceil(2048*audioScale/sampleRate)*movieScale,"elst7");
  const extra=tail+Math.max(0,Math.ceil(difference/audioScale));
  writeInt(elst,offset,width,segment+extra);
  return extra;
}

function patchBytesSlsr(input){
  const data=input;
  const tops=[];let pos=0;
  while(pos<data.length){
    const {name,header,total,zero}=readHeader(data,pos,data.length-pos);
    assert(tops.length<10000&&!["moof","sidx","mfra","ssix"].includes(name),"top");
    tops.push({name,at:pos,size:total,width:header,zero});
    pos+=total;
  }
  const moovs=tops.filter(b=>b.name==="moov");const mdats=tops.filter(b=>b.name==="mdat");
  assert(moovs.length===1&&mdats.length&&moovs[0].width===8&&moovs[0].size<=32*1024*1024,"moov");
  const moov=moovs[0];
  const root=parseBoxes(data,moov.at,moov.at+moov.size)[0];
  const tracks=root.children.filter(b=>b.name==="trak");
  const audioTracks=[];
  for(const track of tracks){const hdlr=child(child(track,"mdia"),"hdlr");if(fourccStr(hdlr.data,8)==="soun")audioTracks.push(track);}
  assert(audioTracks.length===1,"audio1");
  const audio=audioTracks[0];
  const media=child(audio,"mdia");const minf=child(media,"minf");
  const dref=child(child(minf,"dinf"),"dref").data;
  const refs=parseBoxes(dref,8,dref.length);
  assert(u32(dref,0)===0&&u32(dref,4)===refs.length&&refs.length,"dref");
  assert(refs.every(r=>r.name==="url "&&u32(r.data,0)===1),"dref2");

  const stbl=child(minf,"stbl");
  const allowed=new Set(["stsd","stsz","stsc","stts","stco","co64","sbgp","sgpd","subs","free","skip","ctts","stss","stps","sdtp","stdp"]);
  assert(stbl.children.every(c=>allowed.has(c.name)),"stbl");
  const stsd=child(stbl,"stsd");
  const {sampleRate,patchedStsd}=patchAudioDescription(stsd);

  const stsz=child(stbl,"stsz");
  assert(stsz.data.length>=12&&u32(stsz.data,0)===0,"stsz");
  const uniform=u32(stsz.data,4);const sampleCount=u32(stsz.data,8);
  assert(sampleCount>0&&sampleCount<=5000000,"stsz2");
  assert(stsz.data.length===12+(uniform?0:4*sampleCount),"stsz3");
  const sampleSize=(i)=>uniform||u32(stsz.data,12+4*i);

  const stsc=child(stbl,"stsc");const runs=tableCount(stsc,12);
  let offsets;let offsetWidth;
  if(findChild(stbl,"stco")){assert(!findChild(stbl,"co64"),"co64");offsets=findChild(stbl,"stco");}
  else offsets=child(stbl,"co64");
  offsetWidth=offsets.name==="stco"?4:8;
  const chunks=tableCount(offsets,offsetWidth);
  assert(runs>0&&chunks>0,"runs");
  const firstChunk=(i)=>u32(stsc.data,8+12*i);
  assert(firstChunk(0)===1,"fc");
  for(let i=0;i<runs;i++){assert(firstChunk(i)<=chunks,"fc2");assert(i===0||firstChunk(i)>firstChunk(i-1),"fc3");assert(u32(stsc.data,12+12*i)>0,"fc4");assert(u32(stsc.data,16+12*i)===1,"fc5");}
  let run=0,sampled=0;
  for(let index=0;index<chunks;index++){
    if(run+1<runs&&firstChunk(run+1)===index+1)run++;
    const perChunk=u32(stsc.data,12+12*run);
    assert(sampled+perChunk<=sampleCount,"chunk");
    let chunkBytes=0;
    for(let k=0;k<perChunk;k++){const size=sampleSize(sampled);sampled++;assert(size>0,"sz");chunkBytes+=size;}
    const offset=readInt(offsets.data,8+index*offsetWidth,offsetWidth);
    assert(mdats.some(m=>offset>=m.at+m.width&&offset+chunkBytes<=m.at+m.size),"mdat-range");
  }
  assert(sampled===sampleCount,"sampled");

  const stts=child(stbl,"stts");const timingCount=tableCount(stts,8);
  let audioDuration=0,timedSamples=0;const timing=[];
  for(let i=0;i<timingCount;i++){const count=u32(stts.data,8+8*i);const delta=u32(stts.data,12+8*i);assert(count>0&&delta>0,"timing");timing.push([count,delta]);timedSamples+=count;audioDuration+=count*delta;}
  assert(timedSamples===sampleCount,"timed");

  const mdhd=child(media,"mdhd");const mvhd=child(root,"mvhd");const tkhd=child(audio,"tkhd");
  const audioHeader=headerFields(mdhd);const movieHeader=headerFields(mvhd);const trackHeader=headerFields(tkhd);
  assert(audioHeader.scale&&movieHeader.scale&&audioHeader.duration>0,"hdrs");
  assert(Math.abs(audioHeader.duration-audioDuration)<=Math.ceil(2048*audioHeader.scale/sampleRate),"adur");
  assert((tkhd.data[3]&1)&&trackHeader.duration>0,"tkhd-enabled");

  const tailFrames=Math.max(10,Math.ceil(0.35*sampleRate/1024));
  for(const item of stbl.children){
    const payload=item.data;
    if(item.name==="sbgp"){
      const header=payload[0]===1?12:8;
      assert((payload[0]===0||payload[0]===1)&&payload.length>=header+4,"sbgp");
      const groups=u32(payload,header);
      assert(payload.length===header+4+groups*8,"sbgp2");
      let covered=0;for(let g=0;g<groups;g++)covered+=u32(payload,header+4+8*g);
      assert(covered<=sampleCount,"sbgp3");
      const extra=sampleCount-covered+tailFrames;
      if(groups&&u32(payload,payload.length-4)===0){const at=payload.length-8;writeInt(item,at,4,u32(payload,at)+extra);}
      else setData(item,concat([payload.subarray(0,header),p32(groups+1),payload.subarray(header+4),p32s(extra,0)]));
    }else if(item.name==="ctts"){
      const count=tableCount(item,8);let covered=0;
      for(let index=0;index<count;index++){covered+=u32(payload,8+8*index);assert(u32(payload,12+8*index)===0,"ctts");}
      assert(covered===sampleCount,"ctts2");
      setData(item,concat([p32s(0,count+1),payload.subarray(8),p32s(tailFrames,0)]));
    }else if(item.name==="stss"||item.name==="stps"){
      const count=tableCount(item,4);let previous=0;
      for(let index=0;index<count;index++){const value=u32(payload,8+4*index);assert(value>previous&&value<=sampleCount,"stss");previous=value;}
      const extra=[];for(let i=0;i<tailFrames;i++)extra.push(sampleCount+i+1);
      setData(item,concat([p32s(0,count+tailFrames),payload.subarray(8),p32s(...extra)]));
    }else if(item.name==="sdtp"||item.name==="stdp"){
      const stride=item.name==="sdtp"?1:2;
      assert(payload.length===4+stride*sampleCount,"sdtp");
      setData(item,concat([payload,new Uint8Array(stride*tailFrames)]));
    }
  }

  const tailExtra=tailFrames-8;
  const audioTail=Math.floor(tailFrames*1024*audioHeader.scale/sampleRate);
  const movieTail=Math.round(audioTail*movieHeader.scale/audioHeader.scale);
  assert(movieTail>0,"movieTail");
  const editExtra=extendEdit(audio,audioDuration,audioHeader.scale,movieHeader.scale,sampleRate,trackHeader.duration,movieTail);
  writeInt(tkhd,trackHeader.offset,trackHeader.width,trackHeader.duration+editExtra);
  writeInt(mdhd,audioHeader.offset,audioHeader.width,audioHeader.duration+audioTail);

  for(let index=0;index<tailFrames;index++){
    const delta=Math.floor((index+1)*1024*audioHeader.scale/sampleRate)-Math.floor(index*1024*audioHeader.scale/sampleRate);
    assert(delta>0&&delta<=0xFFFFFFFF,"delta");
    if(timing[timing.length-1][1]===delta)timing[timing.length-1][0]+=1;else timing.push([1,delta]);
  }
  const newStts=new Uint8Array(8+timing.length*8);newStts.set(p32(timing.length),4);
  for(let i=0;i<timing.length;i++){newStts.set(p32(timing[i][0]),8+i*8);newStts.set(p32(timing[i][1]),12+i*8);}
  setData(stts,newStts);

  const newStsz=new Uint8Array(12+4*(sampleCount+tailFrames));newStsz.set(p32(sampleCount+tailFrames),8);
  for(let index=0;index<sampleCount+tailFrames;index++)newStsz.set(p32(index<sampleCount?sampleSize(index):SILENT_FRAME.length),12+4*index);
  setData(stsz,newStsz);

  const oldOffsetWidth=offsetWidth;
  const firstOffset=data.length+8;
  const secondOffset=firstOffset+tailExtra*SILENT_FRAME.length;
  offsetWidth=(oldOffsetWidth===8||secondOffset>0xFFFFFFFF)?8:4;
  const newOffsets=new Uint8Array(8+(chunks+2)*offsetWidth);newOffsets.set(p32(chunks+2),4);
  for(let index=0;index<chunks+2;index++){
    let value;
    if(index<chunks)value=readInt(offsets.data,8+index*oldOffsetWidth,oldOffsetWidth);
    else value=index===chunks?firstOffset:secondOffset;
    newOffsets.set(offsetWidth===8?p64(value):p32(value),8+index*offsetWidth);
  }
  offsets.name=offsetWidth===8?"co64":"stco";
  setData(offsets,newOffsets);

  const stscPayload=stsc.data.subarray(8);
  const rebuiltStsc=(desc)=>concat([p32s(0,runs+2),stscPayload,p32s(chunks+1,tailExtra,1,chunks+2,8,desc)]);
  setData(stsc,rebuiltStsc(1));
  const clone=audio.clone();
  setData(stsc,rebuiltStsc(2));
  setData(stsd,patchedStsd);

  const trackId=(item)=>{const t=child(item,"tkhd");return u32(t.data,t.data[0]===1?20:12);};
  const ids=tracks.map(trackId);
  assert(ids.every(x=>x)&&new Set(ids).size===ids.length,"ids");
  const nextId=Math.max(...ids)+1;
  const cloneTkhd=child(clone,"tkhd");
  writeInt(cloneTkhd,cloneTkhd.data[0]===1?20:12,4,nextId);
  const nextOffset=mvhd.data[0]===1?108:96;
  const previousNext=u32(mvhd.data,nextOffset);
  writeInt(mvhd,nextOffset,4,Math.max(nextId+1,previousNext===0xFFFFFFFF?0:previousNext));
  if(movieHeader.duration>0&&!(movieHeader.width===4&&movieHeader.duration===0xFFFFFFFF)){
    let longest=movieHeader.duration;
    for(const track of tracks){const f=headerFields(child(track,"tkhd"));if(f.duration>0&&!(f.width===4&&f.duration===0xFFFFFFFF))longest=Math.max(longest,f.duration);}
    writeInt(mvhd,movieHeader.offset,movieHeader.width,longest);
  }

  root.children.splice(root.children.indexOf(audio)+1,0,clone);
  const silent=concat(Array.from({length:tailFrames},()=>SILENT_FRAME));
  const output=[];
  for(const item of tops){
    if(item===moov) output.push(concat([p32(item.size),te.encode("free"),data.subarray(item.at+8,item.at+item.size)]));
    else if(item.zero){assert(item.size<=0xFFFFFFFF,"zero");output.push(concat([p32(item.size),data.subarray(item.at+4,item.at+item.size)]));}
    else output.push(data.subarray(item.at,item.at+item.size));
  }
  output.push(box("mdat",silent));
  output.push(serialize(root));
  return concat(output);
}


window.__SLSR__ = { patchBytesSlsr };
