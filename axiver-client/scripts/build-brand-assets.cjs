// One vector source for the waiting page, native window, tray and EXE resource.
// Usage: node scripts/build-brand-assets.cjs [absolute path to sharp]
const fs=require('node:fs/promises');
const path=require('node:path');
const sharp=require(process.argv[2]||'sharp');
(async()=>{
  const root=path.resolve(__dirname,'..');
  const source=await fs.readFile(path.join(root,'ui/brand-mark.svg'));
  const sizes=[16,20,24,32,48,64,128,256];
  const images=await Promise.all(sizes.map(size=>sharp(source,{density:384}).resize(size,size).png().toBuffer()));
  await Promise.all([[32,'32x32.png'],[128,'128x128.png'],[256,'icon.png']].map(([size,name])=>fs.writeFile(path.join(root,'icons',name),images[sizes.indexOf(size)])));
  const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);
  let offset=header.length;
  images.forEach((png,i)=>{const entry=6+i*16;header[entry]=sizes[i]%256;header[entry+1]=sizes[i]%256;header.writeUInt16LE(1,entry+4);header.writeUInt16LE(32,entry+6);header.writeUInt32LE(png.length,entry+8);header.writeUInt32LE(offset,entry+12);offset+=png.length;});
  await fs.writeFile(path.join(root,'icons/icon.ico'),Buffer.concat([header,...images]));
  console.log('Updated native icons from ui/brand-mark.svg');
})().catch(error=>{console.error(error);process.exitCode=1;});
