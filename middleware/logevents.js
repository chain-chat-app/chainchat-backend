const {v4:uuid}=require('uuid');
const {format}=require('date-fns');
const path=require('path');
const fs=require('fs');
const fspromises=require('fs').promises

const logevents=async (message,destination)=>{
const logitem=`${uuid()},${format(new Date(),'yyyyMMdd\tHH:mm:ss')}`;
const logmessage=`${logitem}\t${message}\n`

try{
await fspromises.appendFile(path.join(__dirname,'..','logs',destination),logmessage);
}catch(err){
console.log(err)
}

}

const logger=(req,res,next)=>{
    logevents(`${req.url},${req.method},${req.headers.origin}`,'msglog.txt');
    next()
}

module.exports={
    logevents,logger
}