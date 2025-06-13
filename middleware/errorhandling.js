const {logevents}=require('./logevents')
const errorhandler=(err,req,res,next)=>{
    console.log(err.stack)
    logevents(`${err.message}`,'msglog.txt');
   ;
}

module.exports=errorhandler