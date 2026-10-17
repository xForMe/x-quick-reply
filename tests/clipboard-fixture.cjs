// jsdom lacks clipboard constructors. Test-only Web API substitutes, never shipped.
exports.installClipboard = w => {
  w.DataTransfer = class {
    constructor(){this.data=new Map();this.files=[];this.items=[];}
    setData(type,text){this.data.set(type,text);}
    getData(type){return this.data.get(type)||'';}
    get types(){return [...this.data.keys()];}
  };
  w.ClipboardEvent = class extends w.Event {
    constructor(type,options){super(type,options);this.clipboardData=options.clipboardData;}
  };
};
