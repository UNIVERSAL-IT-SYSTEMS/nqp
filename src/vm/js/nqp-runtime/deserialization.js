'use strict';
var op = {};
module.exports.op = op;

var reprs = require('./reprs.js');
var sixmodel = require('./sixmodel.js');
var SerializationContext = require('./serialization-context');
var __6MODEL_CORE__ = require('./bootstrap.js').core;
var Hash = require('./hash.js');
var Int64 = require('node-int64');
var CodeRef = require('./code-ref.js');
var constants = require('./constants.js');

var Null = require('./null.js');

var Ctx = require('./ctx.js');

var containerSpecs = require('./container-specs.js');

var hll = require('./hll.js');

var BOOT = require('./BOOT.js');

/* Possible reference types we can serialize. */
const REFVAR_NULL = 1;
const REFVAR_OBJECT = 2;
const REFVAR_VM_NULL = 3;
const REFVAR_VM_INT = 4;
const REFVAR_VM_NUM = 5;
const REFVAR_VM_STR = 6;
const REFVAR_VM_ARR_VAR = 7;
const REFVAR_VM_ARR_STR = 8;
const REFVAR_VM_ARR_INT = 9;
const REFVAR_VM_HASH_STR_VAR = 10;
const REFVAR_STATIC_CODEREF = 11;
const REFVAR_CLONED_CODEREF = 12;


/** All the loaded serialization contexts using their unique IDs as keys */
var serializationContexts = SerializationContext.contexts;

module.exports.wval = function(handle, idx) {
  return serializationContexts[handle].rootObjects[idx];
};

op.deserialize = function(blob, sc, sh, codeRefs, conflict, setupWVals) {
  var buffer = new Buffer(blob, 'base64');
  sc.codeRefs = codeRefs.array;

  for (var i = 0; i < sc.codeRefs.length; i++) {
    sc.codeRefs[i].isStatic = true;
    sc.codeRefs[i]._SC = sc;
    sc.rootCodes.push(sc.codeRefs[i]);
  }

  sh = sh.array;
  var cursor = new BinaryCursor(buffer, 0, sh, sc);

  cursor.deserialize(sc, setupWVals);
};

op.createsc = function(handle) {
  return (serializationContexts[handle] = new SerializationContext(handle));
};

op.scsetdesc = function(sc, desc) {
  sc.description = desc;
  return desc;
};

op.scgetdesc = function(sc) {
  return sc.description;
};

op.scgethandle = function(sc) {
  return sc.handle;
};

op.scobjcount = function(sc) {
  return sc.rootObjects.length;
};

function int64(high, low) {
  return new Int64(high, low).toNumber();
}

const STABLE_BOOLIFICATION_SPEC_MODE_MASK = 0x0F;
const STABLE_HAS_CONTAINER_SPEC = 0x10;
const STABLE_HAS_INVOCATION_SPEC = 0x20;
const STABLE_HAS_HLL_OWNER = 0x40;
const STABLE_HAS_HLL_ROLE = 0x80;

const STRING_HEAP_LOC_PACKED_OVERFLOW = 0x00008000;
const STRING_HEAP_LOC_PACKED_SHIFT = 16;



/**
  We define a BinaryCursor class so we can read sequential things easily
  @constructor
*/
class BinaryCursor {
  constructor(buffer, offset, sh, sc) {
    this.buffer = buffer;
    this.offset = offset;
    this.sh = sh;
    this.sc = sc;
  }

  /* Export for unit testing*/


  /** Clone the cursor */
  clone() {
    if (!this.sc) {
      console.trace('at', this.sc);
      process.exit();
    }
    return new BinaryCursor(this.buffer, this.offset, this.sh, this.sc);
  }


  /** Return a copy of a cursor at given offset */
  at(offset) {
    if (!this.sc) {
      console.trace('at', this.sc);
      process.exit();
    }
    return new BinaryCursor(this.buffer, offset, this.sh, this.sc);
  }


  /** Read a given element a number of times */
  times(count, cb) {
    var array = [];
    for (var i = 0; i < count; i++) {
      array.push(cb(this));
    }
    return array;
  }


  /** Read an array of elements parsed by the callback */
  array(readElem) {
    var elems = this.varint();
    var array = [];
    for (var i = 0; i < elems; i++) {
      array.push(readElem(this));
    }
    var bootArray = BOOT.createArray(array);
    if (this.sc.currentObject) {
      bootArray._SC = this.sc;
      this.sc.ownedObjects.set(bootArray, this.sc.currentObject);
    }
    return bootArray;
  }



  /** Read an entry from the objects table */
  objectEntry(objectsData) {
    const OBJECTS_TABLE_ENTRY_SC_MASK = 0x7FF;
    const OBJECTS_TABLE_ENTRY_SC_IDX_MASK = 0x000FFFFF;
    const OBJECTS_TABLE_ENTRY_SC_MAX = 0x7FE;
    const OBJECTS_TABLE_ENTRY_SC_IDX_MAX = 0x000FFFFF;
    const OBJECTS_TABLE_ENTRY_SC_SHIFT = 20;
    const OBJECTS_TABLE_ENTRY_SC_OVERFLOW = 0x7FF;
    const OBJECTS_TABLE_ENTRY_IS_CONCRETE = 0x80000000;

    var packed = this.I32();
    var offset = this.I32();

    var sc = (packed >> OBJECTS_TABLE_ENTRY_SC_SHIFT) & OBJECTS_TABLE_ENTRY_SC_MASK;
    var scIdx;

    if (sc == OBJECTS_TABLE_ENTRY_SC_OVERFLOW) {
      throw new Error('Objects Overflow NYI');
    } else {
      scIdx = packed & OBJECTS_TABLE_ENTRY_SC_IDX_MASK;
    }

    return {
      STable: [sc, scIdx],
      data: this.at(objectsData + offset),
      isConcrete: packed & OBJECTS_TABLE_ENTRY_IS_CONCRETE
    };
  }

  locateThing(thingType) {
    var packed;
    var scId;
    var index;
    var sc;

    const PACKED_SC_SHIFT = 20;
    const PACKED_SC_OVERFLOW = 0xfff;
    const PACKED_SC_IDX_MASK = 0x000fffff;

    packed = this.varint();
    scId = packed >>> PACKED_SC_SHIFT;
    index = packed & PACKED_SC_IDX_MASK;

    if (scId != PACKED_SC_OVERFLOW) {
      index = packed & PACKED_SC_IDX_MASK;
    } else {
      scId = this.varint();
      index = this.varint();
    }

    try {
      return this.sc.deps[scId][thingType][index];
    } catch (e) {
      console.log(this.sc.deps.length);
      console.log(e.toString(), scId, thingType, index);
      throw e;
    }
  }


  /**  */
  objRef() {
    return this.locateThing('rootObjects');
  }


  /** Read a hash of variants */
  hashOfVariants() {
    var elems = this.varint();
    var hash = new Hash();
    for (var i = 0; i < elems; i++) {
      var str = this.str();
      hash.content.set(str, this.variant());
    }

    if (this.sc.currentObject) {
      hash._SC = this.sc;
      this.sc.ownedObjects.set(hash, this.sc.currentObject);
    }

    return hash;
  }

  /** Read a int of variable length */
  /* TODO - make it work correctly for values bigger than 32bit integers*/
  // XXX TODO - length checks
  varint() {
    var result;
    var first;
    var need;
    var buffer = this.buffer;

    first = buffer.readUInt8(this.offset++);

    if (first & 0x80) {
      return first - 129;
    }

    need = first >> 4;

    if (!need) {
      // unrolled loop for optimization
      result =
          buffer.readUInt8(this.offset + 0) |
              buffer.readUInt8(this.offset + 1) << 8 |
              buffer.readUInt8(this.offset + 2) << 16 |
              buffer.readUInt8(this.offset + 3) << 24 |
              buffer.readUInt8(this.offset + 4) << 32 |
              buffer.readUInt8(this.offset + 5) << 40 |
              buffer.readUInt8(this.offset + 6) << 48 |
              buffer.readUInt8(this.offset + 7) << 56;
      this.offset += 8;

      return result;
    }

    result = (first & 0x0F) << 8 * need;

    var shiftPlaces = 0;
    for (var i = 0; i < need; i++) {
      var byte = buffer.readUInt8(this.offset++);
      result |= (byte << shiftPlaces);
      shiftPlaces += 8;
    }

    if (need < 4) {
      result = result << (64 - 4 - 8 * need);
      result = result >> (64 - 4 - 8 * need);
    }

    return result;
  }


  /** Read a variant reference, REFVAR_NULL is returned as undefined */
  variantWithUndefined() {
    var type = this.I8();
    switch (type) {
      case REFVAR_OBJECT:
        return this.objRef();
      case REFVAR_NULL:
        return undefined;
      case REFVAR_VM_NULL:
        return Null;
      case REFVAR_VM_INT:
        // TODO deserialize bigger integers then can fit into a 32bit number
        return this.varint();
      case REFVAR_VM_NUM:
        return this.double();
      case REFVAR_VM_STR:
        return this.str();
      case REFVAR_VM_ARR_VAR:
        return this.array(function(cursor) {return cursor.variant()});
      case REFVAR_VM_ARR_STR:
        return this.array(function(cursor) {return cursor.str()});
        /* TODO varints */
      /*    case 9:
        return this.array(function(cursor) {return cursor.I64()});*/
      case REFVAR_VM_HASH_STR_VAR:
        return this.hashOfVariants(this);
      case REFVAR_STATIC_CODEREF:
      case REFVAR_CLONED_CODEREF:
        var codeRef = this.locateThing('codeRefs');
        if (!codeRef) {
          console.log('missing code ref while deserializing');
          console.log(this.sc.codeRefs);
        }
        return codeRef;
      default:
        console.trace('unknown variant');
        throw 'unknown variant: ' + type;
    }

  }

  /** Read a variant reference, REFVAR_NULL is returned as Null */
  variant() {
    var result = this.variantWithUndefined();
    return result === undefined ? Null : result;
  }

  /** Read an entry from the STable table */
  STable(STable) {
    STable.HOW = this.objRef();
    STable.WHAT = this.objRef();
    STable.WHO = this.variant();

    var methodCache = this.variant();

    STable._methodCache = methodCache;

    var typeCheckCache = [];
    var typeCheckCacheLen = this.varint();
    for (var i = 0; i < typeCheckCacheLen; i++) {
      typeCheckCache.push(this.variant());
    }

    if (typeCheckCache.length != 0) {
      STable.typeCheckCache = typeCheckCache;
    }

    STable.modeFlags = this.U8();

    var flags = this.U8();
    var boolificationMode = flags & 0xF;

    if (boolificationMode != 0xF) {
      var boolificationMethod = this.variant();
      STable.setboolspec(boolificationMode, boolificationMethod);
    }

    if (flags & STABLE_HAS_CONTAINER_SPEC) {
      var specType = this.str();
      STable.containerSpec = new containerSpecs[specType](STable);
      STable.containerSpec.deserialize(this);
    }

    if (flags & STABLE_HAS_INVOCATION_SPEC) {
      var classHandle = this.variant();
      var attrName = this.str();
      this.varint(); // hint
      var invocationHandler = this.variant();

      this.variant(); // md_class_handle
      this.str(); // md_cache_attr_name
      this.varint(); // md_cache_hint
      this.str(); // md_valid_attr_name
      this.varint(); // md_valid_hint

    }

    if (flags & STABLE_HAS_HLL_OWNER) {
      STable.hllOwner = hll.getHLL(this.str());
    }

    if (flags & STABLE_HAS_HLL_ROLE) {
      STable.hllRole = this.varint();
    }

    if (STable.modeFlags & constants.PARAMETRIC_TYPE) {
      STable.parameterizer = this.variant();

      if (!STable.parameterizerCache) {
        STable.parameterizerCache = [];
      }

    }

    if (STable.modeFlags & constants.PARAMETERIZED_TYPE) {
      STable.parametricType = this.variant();
      var count = this.varint();
      var params = [];
      for (var i = 0; i < count; i++) {
        params[i] = this.variant();
      }

      var ptable = STable.parametricType._STable;

      if (!ptable.parameterizerCache) {
        ptable.parameterizerCache = [];
      }

      STable.parameters = BOOT.createArray(params);

      ptable.parameterizerCache.push({type: STable.WHAT, params: params});
    }

    STable.debugName = this.cstr();

    if (STable.REPR.deserializeReprData) {
      STable.REPR.deserializeReprData(this.clone(), STable);
    }

    if (flags & STABLE_HAS_INVOCATION_SPEC) {
      STable.setinvokespec(classHandle, attrName, invocationHandler);
    }

    if (STable.containerSpec) STable.containerSpec.setupSTable(this);
  }

  staticCodeRef() {
    var staticCode = this.locateThing('codeRefs');
    if (!staticCode) {
      console.log('Code ref has an invalid static code');
    }
    return staticCode;
  }

  closureEntry() {
    var entry = {};
    var staticScId = this.I32();
    var staticIndex = this.I32();
    entry.staticCode = this.sc.deps[staticScId].codeRefs[staticIndex];
    entry.context = this.I32();
    var hasCodeObj = this.I32();
    if (hasCodeObj) {
      var objectScId = this.I32();
      var objectIndex = this.I32();
      entry.codeObj = this.sc.deps[objectScId].rootObjects[objectIndex];
    } else {
      // we're packed along a 24-byte alignment
      this.I32();
      this.I32();
    }
    return entry;
  }

  contextEntry(contextsData) {
    var entry = {};
    var staticScId = this.I32();
    var staticIndex = this.I32();
    entry.staticCode = this.sc.deps[staticScId].codeRefs[staticIndex];
    var data = this.at(contextsData + this.I32());
    entry.outer = this.I32();
    entry.inner = [];
    entry.closures = [];

    var count = data.varint();
    var info = entry.staticCode.lexicalsTypeInfo;

    var lexicals = {};

    for (var i = 0; i < count; i++) {
      var name = data.str();

      if (!info.hasOwnProperty([name])) {
        throw 'no static info for: ', name;
      }

      switch (info[name]) {
        case 0: // obj
          lexicals[name] = data.variant();
          break;
        case 1: // int
          lexicals[name] = data.varint();
          break;
        case 2: // num
          lexicals[name] = data.double();
          break;
        case 3: // str
          lexicals[name] = data.str();
      }
    }

    entry.lexicals = lexicals;

    return entry;
  }


  /** Read a whole serialization context, if defined call the setupWVals before the closures are created */
  deserialize(sc, setupWVals) {
    var version = this.I32();

    this.sc = sc;

    if (version != 20) {
      throw 'Unsupported serialization format version: ' + version;
    }

    var depsOffset = this.I32();
    var depsNumber = this.I32();


    var dependencies = this.at(depsOffset).times(depsNumber,
        function(cursor) { return [cursor.str32(), cursor.str32()]; });

    var deps = [sc];
    this.sc.deps = deps;

    for (var i in dependencies) {
      var dep = serializationContexts[dependencies[i][0]];
      if (!dep) {
        //console.log(Object.keys(serializationContexts));
        console.log(
            "Missing dependencie, can't find serialization context handle:",
            dependencies[i][0],
            'desc:', dependencies[i][1]);
        process.exit();
      }
      deps.push(dep);
    }


    var STablesOffset = this.I32();
    var STablesNumber = this.I32();
    var STablesData = this.I32();

    var STables = this.at(STablesOffset).times(STablesNumber,
        function(cursor) {
          return [cursor.str32(), cursor.at(STablesData + cursor.I32()), cursor.at(STablesData + cursor.I32())];
        });


    var objectsOffset = this.I32();
    var objectsNumber = this.I32();
    var objectsData = this.I32();
    var objects = this.at(objectsOffset).times(objectsNumber, function(cursor) {
      return cursor.objectEntry(objectsData);
    });


    var reposTable = this.at(4 * 14).I32();
    var numRepos = this.at(4 * 15).I32();

    var repossessed = this.at(reposTable).times(numRepos, function(cursor) {
      return {type: cursor.I32(), index: cursor.I32(), origSC: cursor.I32(), origIndex: cursor.I32()};
    });

    this.repossessSTables(repossessed);

    this.stubSTables(STables);

    this.repossessObjects(objects, repossessed);

    this.stubObjects(objects);


    var closuresOffset = this.I32();
    var closuresNumber = this.I32();
    var closures = this.at(closuresOffset).times(closuresNumber, function(cursor) {
      return cursor.closureEntry();
    });

    var closuresBase = sc.codeRefs.length;
    for (var i = 0; i < closures.length; i++) {
      sc.codeRefs[closuresBase + i] = new CodeRef(closures[i].staticCode.name, undefined);
      sc.codeRefs[closuresBase + i].staticCode = closures[i].staticCode;
      if (closures[i].codeObj) sc.codeRefs[closuresBase + i].codeObj = closures[i].codeObj;
      closures[i].index = closuresBase + i;

      closures[i]._SC = sc;
      sc.rootCodes.push(closures[i]);
    }

    this.deserializeSTables(STables);

    this.deserializeObjects(objects);

    if (setupWVals) setupWVals();

    var contextsOffset = this.I32();
    var contextsNumber = this.I32();
    var contextsData = this.I32();
    var contexts = this.at(contextsOffset).times(contextsNumber, function(cursor) {
      return cursor.contextEntry(contextsData);
    });

    for (var i = 0; i < contexts.length; i++) {
      if (contexts[i].outer) contexts[contexts[i].outer - 1].inner.push(contexts[i]);
    }

    var noContextClosures = [];


    for (var i = 0; i < closures.length; i++) {
      if (closures[i].context) {
        contexts[closures[i].context - 1].closures.push(closures[i]);
      } else {
        noContextClosures.push(closures[i]);
      }
    }

    for (var closure of noContextClosures) {
      var closureTemplate = closure.staticCode.closureTemplate;
      var fakeCtxs = [];
      var i = closureTemplate.length;
      while (i--) {
        fakeCtxs.push(null);
      }
      var built = closureTemplate.apply(null, fakeCtxs);
      sc.codeRefs[closure.index].capture(built);
    }

    for (var i = 0; i < contexts.length; i++) {
      if (contexts[i].outer == 0) {
        this.deserializeCtx(contexts[i], []);
      }
    }


    // reposTable
    this.I32();
    //numRepos
    this.I32();

    var paramInternsData = this.I32();
    var numParamInterns = this.I32();

    if (numParamInterns != 0) {
      // XXX do we need to care?
    }


    /* We set the method caches after everything else is ready */
    for (var i = 0; i < STables.length; i++) {
      var STable = sc.rootSTables[i];
      if (STable._methodCache instanceof Hash) {
        STable.setMethodCache(STable._methodCache.$$toObject());
      }
    }
  }

  stubSTables(STables) {
    for (var i = 0; i < STables.length; i++) {
      // May already have it, due to repossession.
      if (!this.sc.rootSTables[i]) {
        var repr = STables[i][0];
        if (!reprs[repr]) {
          throw 'Unknown REPR: ' + repr;
        }
        var REPR = new reprs[repr]();
        REPR.name = repr;
        var HOW = null; /* We will fill that in later once objects are stubbed */
        this.sc.rootSTables[i] = new sixmodel.STable(REPR, HOW);
        this.sc.rootSTables[i]._SC = this.sc;
      }
    }
  }

  deserializeSTables(STables) {
    for (var i = 0; i < STables.length; i++) {
      STables[i][1].STable(this.sc.rootSTables[i]);
    }
  }

  stubObjects(objects) {
    for (var i = 0; i < objects.length; i++) {
      if (!this.sc.rootObjects[i]) {
        var STableForObj =
            this.sc.deps[objects[i].STable[0]].rootSTables[objects[i].STable[1]];
        if (!STableForObj) {
          console.log('Missing stable', objects[i].STable[0], objects[i].STable[1], deps[objects[i].STable[0]].rootSTables);
        }

        this.sc.rootObjects[i] = objects[i].isConcrete ?
            new (STableForObj.objConstructor)() :
            STableForObj.createTypeObject();
        this.sc.rootObjects[i]._SC = this.sc;
      }
    }
  }

  deserializeObjects(objects) {
    for (var i = 0; i < objects.length; i++) {
      if (objects[i].isConcrete) {
        var repr = this.sc.rootObjects[i]._STable.REPR;
        if (repr.deserializeFinish) {
          this.sc.currentObject = this.sc.rootObjects[i];
          repr.deserializeFinish(this.sc.rootObjects[i], objects[i].data);
          this.sc.currentObject = undefined;
        }
      }
    }
  }

  repossessSTables(repossessed) {
    for (let entry of repossessed) {
      if (entry.type === 1) {
        let origSTable = this.sc.deps[entry.origSC].rootSTables[entry.origIndex];
        this.sc.rootSTables[entry.index] = origSTable;
        origSTable._SC = this.sc;
      }
    }
  }

  repossessObjects(objects, repossessed) {
    for (let entry of repossessed) {
      if (entry.type === 0) {
        let origObj = this.sc.deps[entry.origSC].rootObjects[entry.origIndex];
        this.sc.rootObjects[entry.index] = origObj;
        origObj._SC = this.sc;

        var STableForObj =
            this.sc.deps[objects[entry.index].STable[0]].rootSTables[objects[entry.index].STable[1]];

        /* The object's STable may have changed as a result of the
         * repossession (perhaps due to mixing in to it), so put the
         * STable it should now have in place. */

        if (STableForObj !== origObj._STable) {
          Object.setPrototypeOf(origObj, STableForObj.objConstructor.prototype);
        }
      }
    }
  }

  deserializeCtx(context, outers) {
    var outerCtx = outers.length != 0 ? outers[outers.length - 1] : null;
    var callerCtx = null;

    // TODO - think if we should set codeObj
    var ctx = new Ctx(outerCtx, callerCtx);

    var lexicals = [];

    for (var name in context.lexicals) {
      ctx[name] = context.lexicals[name];
    }

    var newOuters = outers.slice();
    newOuters.push(ctx);


    for (var inner of context.inner) {
      this.deserializeCtx(inner, newOuters);
    }

    ctx.closuresUsingThis = [];
    for (var closure of context.closures) {
      var closureTemplate = closure.staticCode.closureTemplate;
      var codeRef = this.sc.codeRefs[closure.index];
      while (newOuters.length < closure.staticCode.closureTemplate.length) newOuters.unshift(null);
      codeRef.capture(closureTemplate.apply(null, newOuters));

      ctx.closuresUsingThis.push(codeRef);
      for (let outer of outers) {
        if (!outer.closuresUsingThis) outer.closuresUsingThis = [];
        outer.closuresUsingThis.push(codeRef);
      }

      codeRef.outerCtx = ctx;
    }

  }


  /** Read a 32bit integer */
  I32() {
    var ret = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return ret;
  }

  U8() {
    var ret = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return ret;
  }

  U16() {
    var ret = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return ret;
  }

  U32() {
    var ret = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return ret;
  }

  I8() {
    var ret = this.buffer.readInt8(this.offset);
    this.offset += 1;
    return ret;
  }




  /** Read a 64bit integer */
  I64() {
    var low = this.buffer.readUInt32LE(this.offset);
    var high = this.buffer.readUInt32LE(this.offset + 4);
    this.offset += 8;
    return int64(high, low);
  }


  /** Read a 64bit floating point number */
  double() {
    var ret = this.buffer.readDoubleLE(this.offset);
    this.offset += 8;
    return ret;
  }


  /** Read a flag stored as a 64bit integer */
  flag64() {
    var low = this.buffer.readUInt32LE(this.offset);
    var high = this.buffer.readUInt32LE(this.offset + 4);
    this.offset += 8;
    if (high) {
      console.trace('here');
      throw 'the high part of a flag should be empty , got: ' + high;
    }
    if (low != 0 && low != 1) {
      console.trace('here');
      throw 'the low part of a flag should be 1 or 0, got: ' + low;
    }
    return low;
  }



  /** Read a String */
  str() {
    var offset = this.U16();
    if (offset & STRING_HEAP_LOC_PACKED_OVERFLOW) {
      offset ^= STRING_HEAP_LOC_PACKED_OVERFLOW;
      offset <<= STRING_HEAP_LOC_PACKED_SHIFT;
      offset |= this.U16();
    }
    if (!this.sh.hasOwnProperty(offset)) {
      throw "can't read str: " + offset;
    }
    return this.sh[offset];
  }


  /** Read a C String */
  cstr() {
    var len = this.varint();
    var str = this.buffer.slice(this.offset, len).toString('utf8');
    this.offset += len;
    return str;
  }

  str32() {
    return this.sh[this.I32()];
  }
};

exports.BinaryCursor = BinaryCursor;
