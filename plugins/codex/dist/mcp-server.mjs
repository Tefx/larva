import { createRequire as larvaCreateRequire } from "node:module";
const require = larvaCreateRequire(import.meta.url);
import { realpathSync as larvaRealpath } from "node:fs";
import { fileURLToPath as larvaFilePath } from "node:url";
const larvaIsMain = import.meta.main ?? (() => {
  try {
    return process.argv[1] !== undefined && larvaRealpath(process.argv[1]) === larvaFilePath(import.meta.url);
  } catch { return false; }
})();
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS({
  "node_modules/yaml/dist/nodes/identity.js"(exports) {
    "use strict";
    var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
    var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
    var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
    var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
    var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
    var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
    var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
    var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
    var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
    var isMap2 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
    var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
    var isScalar2 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
    var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
    function isCollection2(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    function isNode(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    var hasAnchor = (node) => (isScalar2(node) || isCollection2(node)) && !!node.anchor;
    exports.ALIAS = ALIAS;
    exports.DOC = DOC;
    exports.MAP = MAP;
    exports.NODE_TYPE = NODE_TYPE;
    exports.PAIR = PAIR;
    exports.SCALAR = SCALAR;
    exports.SEQ = SEQ;
    exports.hasAnchor = hasAnchor;
    exports.isAlias = isAlias;
    exports.isCollection = isCollection2;
    exports.isDocument = isDocument;
    exports.isMap = isMap2;
    exports.isNode = isNode;
    exports.isPair = isPair;
    exports.isScalar = isScalar2;
    exports.isSeq = isSeq;
  }
});

// node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "node_modules/yaml/dist/visit.js"(exports) {
    "use strict";
    var identity = require_identity();
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove node");
    function visit2(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    visit2.BREAK = BREAK;
    visit2.SKIP = SKIP;
    visit2.REMOVE = REMOVE;
    function visit_(key, node, visitor, path) {
      const ctrl = callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visit_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = visit_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = visit_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = visit_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    async function visitAsync(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        await visitAsync_(null, node, visitor_, Object.freeze([]));
    }
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node, visitor, path) {
      const ctrl = await callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visitAsync_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = await visitAsync_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = await visitAsync_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = await visitAsync_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    function initVisitor(visitor) {
      if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
        return Object.assign({
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node
        }, visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value
        }, visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection
        }, visitor);
      }
      return visitor;
    }
    function callVisitor(key, node, visitor, path) {
      if (typeof visitor === "function")
        return visitor(key, node, path);
      if (identity.isMap(node))
        return visitor.Map?.(key, node, path);
      if (identity.isSeq(node))
        return visitor.Seq?.(key, node, path);
      if (identity.isPair(node))
        return visitor.Pair?.(key, node, path);
      if (identity.isScalar(node))
        return visitor.Scalar?.(key, node, path);
      if (identity.isAlias(node))
        return visitor.Alias?.(key, node, path);
      return void 0;
    }
    function replaceNode(key, path, node) {
      const parent = path[path.length - 1];
      if (identity.isCollection(parent)) {
        parent.items[key] = node;
      } else if (identity.isPair(parent)) {
        if (key === "key")
          parent.key = node;
        else
          parent.value = node;
      } else if (identity.isDocument(parent)) {
        parent.contents = node;
      } else {
        const pt = identity.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    exports.visit = visit2;
    exports.visitAsync = visitAsync;
  }
});

// node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "node_modules/yaml/dist/doc/directives.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit2 = require_visit();
    var escapeChars = {
      "!": "%21",
      ",": "%2C",
      "[": "%5B",
      "]": "%5D",
      "{": "%7B",
      "}": "%7D"
    };
    var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
    var Directives = class _Directives {
      constructor(yaml, tags) {
        this.docStart = null;
        this.docEnd = false;
        this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
        this.tags = Object.assign({}, _Directives.defaultTags, tags);
      }
      clone() {
        const copy = new _Directives(this.yaml, this.tags);
        copy.docStart = this.docStart;
        return copy;
      }
      /**
       * During parsing, get a Directives instance for the current document and
       * update the stream state according to the current version's spec.
       */
      atDocument() {
        const res = new _Directives(this.yaml, this.tags);
        switch (this.yaml.version) {
          case "1.1":
            this.atNextDocument = true;
            break;
          case "1.2":
            this.atNextDocument = false;
            this.yaml = {
              explicit: _Directives.defaultYaml.explicit,
              version: "1.2"
            };
            this.tags = Object.assign({}, _Directives.defaultTags);
            break;
        }
        return res;
      }
      /**
       * @param onError - May be called even if the action was successful
       * @returns `true` on success
       */
      add(line, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line.trim().split(/[ \t]+/);
        const name = parts.shift();
        switch (name) {
          case "%TAG": {
            if (parts.length !== 2) {
              onError(0, "%TAG directive should contain exactly two parts");
              if (parts.length < 2)
                return false;
            }
            const [handle, prefix] = parts;
            this.tags[handle] = prefix;
            return true;
          }
          case "%YAML": {
            this.yaml.explicit = true;
            if (parts.length !== 1) {
              onError(0, "%YAML directive should contain exactly one part");
              return false;
            }
            const [version] = parts;
            if (version === "1.1" || version === "1.2") {
              this.yaml.version = version;
              return true;
            } else {
              const isValid = /^\d+\.\d+$/.test(version);
              onError(6, `Unsupported YAML version ${version}`, isValid);
              return false;
            }
          }
          default:
            onError(0, `Unknown directive ${name}`, true);
            return false;
        }
      }
      /**
       * Resolves a tag, matching handles to those defined in %TAG directives.
       *
       * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
       *   `'!local'` tag, or `null` if unresolvable.
       */
      tagName(source, onError) {
        if (source === "!")
          return "!";
        if (source[0] !== "!") {
          onError(`Not a valid tag: ${source}`);
          return null;
        }
        if (source[1] === "<") {
          const verbatim = source.slice(2, -1);
          if (verbatim === "!" || verbatim === "!!") {
            onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
            return null;
          }
          if (source[source.length - 1] !== ">")
            onError("Verbatim tags must end with a >");
          return verbatim;
        }
        const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
        if (!suffix)
          onError(`The ${source} tag has no suffix`);
        const prefix = this.tags[handle];
        if (prefix) {
          try {
            return prefix + decodeURIComponent(suffix);
          } catch (error) {
            onError(String(error));
            return null;
          }
        }
        if (handle === "!")
          return source;
        onError(`Could not resolve tag: ${source}`);
        return null;
      }
      /**
       * Given a fully resolved tag, returns its printable string form,
       * taking into account current tag prefixes and defaults.
       */
      tagString(tag) {
        for (const [handle, prefix] of Object.entries(this.tags)) {
          if (tag.startsWith(prefix))
            return handle + escapeTagName(tag.substring(prefix.length));
        }
        return tag[0] === "!" ? tag : `!<${tag}>`;
      }
      toString(doc) {
        const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
          const tags = {};
          visit2.visit(doc.contents, (_key, node) => {
            if (identity.isNode(node) && node.tag)
              tags[node.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines.push(`%TAG ${handle} ${prefix}`);
        }
        return lines.join("\n");
      }
    };
    Directives.defaultYaml = { explicit: false, version: "1.2" };
    Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
    exports.Directives = Directives;
  }
});

// node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS({
  "node_modules/yaml/dist/doc/anchors.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit2 = require_visit();
    function anchorIsValid(anchor) {
      if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
        const sa = JSON.stringify(anchor);
        const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg);
      }
      return true;
    }
    function anchorNames(root) {
      const anchors = /* @__PURE__ */ new Set();
      visit2.visit(root, {
        Value(_key, node) {
          if (node.anchor)
            anchors.add(node.anchor);
        }
      });
      return anchors;
    }
    function findNewAnchor(prefix, exclude) {
      for (let i = 1; true; ++i) {
        const name = `${prefix}${i}`;
        if (!exclude.has(name))
          return name;
      }
    }
    function createNodeAnchors(doc, prefix) {
      const aliasObjects = [];
      const sourceObjects = /* @__PURE__ */ new Map();
      let prevAnchors = null;
      return {
        onAnchor: (source) => {
          aliasObjects.push(source);
          prevAnchors ?? (prevAnchors = anchorNames(doc));
          const anchor = findNewAnchor(prefix, prevAnchors);
          prevAnchors.add(anchor);
          return anchor;
        },
        /**
         * With circular references, the source node is only resolved after all
         * of its child nodes are. This is why anchors are set only after all of
         * the nodes have been created.
         */
        setAnchors: () => {
          for (const source of aliasObjects) {
            const ref = sourceObjects.get(source);
            if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
              ref.node.anchor = ref.anchor;
            } else {
              const error = new Error("Failed to resolve repeated object (this should not happen)");
              error.source = source;
              throw error;
            }
          }
        },
        sourceObjects
      };
    }
    exports.anchorIsValid = anchorIsValid;
    exports.anchorNames = anchorNames;
    exports.createNodeAnchors = createNodeAnchors;
    exports.findNewAnchor = findNewAnchor;
  }
});

// node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS({
  "node_modules/yaml/dist/doc/applyReviver.js"(exports) {
    "use strict";
    function applyReviver(reviver, obj, key, val) {
      if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          for (let i = 0, len = val.length; i < len; ++i) {
            const v0 = val[i];
            const v1 = applyReviver(reviver, val, String(i), v0);
            if (v1 === void 0)
              delete val[i];
            else if (v1 !== v0)
              val[i] = v1;
          }
        } else if (val instanceof Map) {
          for (const k of Array.from(val.keys())) {
            const v0 = val.get(k);
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              val.delete(k);
            else if (v1 !== v0)
              val.set(k, v1);
          }
        } else if (val instanceof Set) {
          for (const v0 of Array.from(val)) {
            const v1 = applyReviver(reviver, val, v0, v0);
            if (v1 === void 0)
              val.delete(v0);
            else if (v1 !== v0) {
              val.delete(v0);
              val.add(v1);
            }
          }
        } else {
          for (const [k, v0] of Object.entries(val)) {
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              delete val[k];
            else if (v1 !== v0)
              val[k] = v1;
          }
        }
      }
      return reviver.call(obj, key, val);
    }
    exports.applyReviver = applyReviver;
  }
});

// node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS({
  "node_modules/yaml/dist/nodes/toJS.js"(exports) {
    "use strict";
    var identity = require_identity();
    function toJS(value, arg, ctx) {
      if (Array.isArray(value))
        return value.map((v, i) => toJS(v, String(i), ctx));
      if (value && typeof value.toJSON === "function") {
        if (!ctx || !identity.hasAnchor(value))
          return value.toJSON(arg, ctx);
        const data = { aliasCount: 0, count: 1, res: void 0 };
        ctx.anchors.set(value, data);
        ctx.onCreate = (res2) => {
          data.res = res2;
          delete ctx.onCreate;
        };
        const res = value.toJSON(arg, ctx);
        if (ctx.onCreate)
          ctx.onCreate(res);
        return res;
      }
      if (typeof value === "bigint" && !ctx?.keep)
        return Number(value);
      return value;
    }
    exports.toJS = toJS;
  }
});

// node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS({
  "node_modules/yaml/dist/nodes/Node.js"(exports) {
    "use strict";
    var applyReviver = require_applyReviver();
    var identity = require_identity();
    var toJS = require_toJS();
    var NodeBase = class {
      constructor(type) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: type });
      }
      /** Create a copy of this node.  */
      clone() {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** A plain JavaScript representation of this node. */
      toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        if (!identity.isDocument(doc))
          throw new TypeError("A document argument is required");
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc,
          keep: true,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this, "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
    };
    exports.NodeBase = NodeBase;
  }
});

// node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS({
  "node_modules/yaml/dist/nodes/Alias.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var visit2 = require_visit();
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var Alias = class extends Node.NodeBase {
      constructor(source) {
        super(identity.ALIAS);
        this.source = source;
        Object.defineProperty(this, "tag", {
          set() {
            throw new Error("Alias nodes cannot have tags");
          }
        });
      }
      /**
       * Resolve the value of this alias within `doc`, finding the last
       * instance of the `source` anchor before this node.
       */
      resolve(doc, ctx) {
        if (ctx?.maxAliasCount === 0)
          throw new ReferenceError("Alias resolution is disabled");
        let nodes;
        if (ctx?.aliasResolveCache) {
          nodes = ctx.aliasResolveCache;
        } else {
          nodes = [];
          visit2.visit(doc, {
            Node: (_key, node) => {
              if (identity.isAlias(node) || identity.hasAnchor(node))
                nodes.push(node);
            }
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node of nodes) {
          if (node === this)
            break;
          if (node.anchor === this.source)
            found = node;
        }
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const { anchors: anchors2, doc, maxAliasCount } = ctx;
        const source = this.resolve(doc, ctx);
        if (!source) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        let data = anchors2.get(source);
        if (!data) {
          toJS.toJS(source, null, ctx);
          data = anchors2.get(source);
        }
        if (data?.res === void 0) {
          const msg = "This should not happen: Alias anchor was not resolved?";
          throw new ReferenceError(msg);
        }
        if (maxAliasCount >= 0) {
          data.count += 1;
          if (data.aliasCount === 0)
            data.aliasCount = getAliasCount(doc, source, anchors2);
          if (data.count * data.aliasCount > maxAliasCount) {
            const msg = "Excessive alias count indicates a resource exhaustion attack";
            throw new ReferenceError(msg);
          }
        }
        return data.res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg);
          }
          if (ctx.implicitKey)
            return `${src} `;
        }
        return src;
      }
    };
    function getAliasCount(doc, node, anchors2) {
      if (identity.isAlias(node)) {
        const source = node.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity.isCollection(node)) {
        let count = 0;
        for (const item of node.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count)
            count = c;
        }
        return count;
      } else if (identity.isPair(node)) {
        const kc = getAliasCount(doc, node.key, anchors2);
        const vc = getAliasCount(doc, node.value, anchors2);
        return Math.max(kc, vc);
      }
      return 1;
    }
    exports.Alias = Alias;
  }
});

// node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS({
  "node_modules/yaml/dist/nodes/Scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
    var Scalar = class extends Node.NodeBase {
      constructor(value) {
        super(identity.SCALAR);
        this.value = value;
      }
      toJSON(arg, ctx) {
        return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
      }
      toString() {
        return String(this.value);
      }
    };
    Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
    Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
    Scalar.PLAIN = "PLAIN";
    Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
    Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
    exports.Scalar = Scalar;
    exports.isScalarValue = isScalarValue;
  }
});

// node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS({
  "node_modules/yaml/dist/doc/createNode.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var defaultTagPrefix = "tag:yaml.org,2002:";
    function findTagObject(value, tagName, tags) {
      if (tagName) {
        const match = tags.filter((t) => t.tag === tagName);
        const tagObj = match.find((t) => !t.format) ?? match[0];
        if (!tagObj)
          throw new Error(`Tag ${tagName} not found`);
        return tagObj;
      }
      return tags.find((t) => t.identify?.(value) && !t.format);
    }
    function createNode(value, tagName, ctx) {
      if (identity.isDocument(value))
        value = value.contents;
      if (identity.isNode(value))
        return value;
      if (identity.isPair(value)) {
        const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
        map.items.push(value);
        return map;
      }
      if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
        value = value.valueOf();
      }
      const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
      let ref = void 0;
      if (aliasDuplicateObjects && value && typeof value === "object") {
        ref = sourceObjects.get(value);
        if (ref) {
          ref.anchor ?? (ref.anchor = onAnchor(value));
          return new Alias.Alias(ref.anchor);
        } else {
          ref = { anchor: null, node: null };
          sourceObjects.set(value, ref);
        }
      }
      if (tagName?.startsWith("!!"))
        tagName = defaultTagPrefix + tagName.slice(2);
      let tagObj = findTagObject(value, tagName, schema.tags);
      if (!tagObj) {
        if (value && typeof value.toJSON === "function") {
          value = value.toJSON();
        }
        if (!value || typeof value !== "object") {
          const node2 = new Scalar.Scalar(value);
          if (ref)
            ref.node = node2;
          return node2;
        }
        tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
      if (tagName)
        node.tag = tagName;
      else if (!tagObj.default)
        node.tag = tagObj.tag;
      if (ref)
        ref.node = node;
      return node;
    }
    exports.createNode = createNode;
  }
});

// node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS({
  "node_modules/yaml/dist/nodes/Collection.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var identity = require_identity();
    var Node = require_Node();
    function collectionFromPath(schema, path, value) {
      let v = value;
      for (let i = path.length - 1; i >= 0; --i) {
        const k = path[i];
        if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
          const a = [];
          a[k] = v;
          v = a;
        } else {
          v = /* @__PURE__ */ new Map([[k, v]]);
        }
      }
      return createNode.createNode(v, void 0, {
        aliasDuplicateObjects: false,
        keepUndefined: false,
        onAnchor: () => {
          throw new Error("This should not happen, please report a bug.");
        },
        schema,
        sourceObjects: /* @__PURE__ */ new Map()
      });
    }
    var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
    var Collection = class extends Node.NodeBase {
      constructor(type, schema) {
        super(type);
        Object.defineProperty(this, "schema", {
          value: schema,
          configurable: true,
          enumerable: false,
          writable: true
        });
      }
      /**
       * Create a copy of this collection.
       *
       * @param schema - If defined, overwrites the original's schema
       */
      clone(schema) {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (schema)
          copy.schema = schema;
        copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /**
       * Adds a value to the collection. For `!!map` and `!!omap` the value must
       * be a Pair instance or a `{ key, value }` object, which may not have a key
       * that already exists in the map.
       */
      addIn(path, value) {
        if (isEmptyPath(path))
          this.add(value);
        else {
          const [key, ...rest] = path;
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.addIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.delete(key);
        const node = this.get(key, true);
        if (identity.isCollection(node))
          return node.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity.isScalar(node) ? node.value : node;
        else
          return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node) => {
          if (!identity.isPair(node))
            return false;
          const n = node.value;
          return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.has(key);
        const node = this.get(key, true);
        return identity.isCollection(node) ? node.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        const [key, ...rest] = path;
        if (rest.length === 0) {
          this.set(key, value);
        } else {
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.setIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
    };
    exports.Collection = Collection;
    exports.collectionFromPath = collectionFromPath;
    exports.isEmptyPath = isEmptyPath;
  }
});

// node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyComment.js"(exports) {
    "use strict";
    var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
    function indentComment(comment, indent) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
    }
    var lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
    exports.indentComment = indentComment;
    exports.lineComment = lineComment;
    exports.stringifyComment = stringifyComment;
  }
});

// node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS({
  "node_modules/yaml/dist/stringify/foldFlowLines.js"(exports) {
    "use strict";
    var FOLD_FLOW = "flow";
    var FOLD_BLOCK = "block";
    var FOLD_QUOTED = "quoted";
    function foldFlowLines(text2, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text2;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
      if (text2.length <= endStep)
        return text2;
      const folds = [];
      const escapedFolds = {};
      let end = lineWidth - indent.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text2, i, indent.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text2[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text2[i + 1]) {
            case "x":
              i += 3;
              break;
            case "u":
              i += 5;
              break;
            case "U":
              i += 9;
              break;
            default:
              i += 1;
          }
          escEnd = i;
        }
        if (ch === "\n") {
          if (mode === FOLD_BLOCK)
            i = consumeMoreIndentedLines(text2, i, indent.length);
          end = i + indent.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text2[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end) {
            if (split) {
              folds.push(split);
              end = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text2[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text2;
              folds.push(j);
              escapedFolds[j] = true;
              end = j + endStep;
              split = void 0;
            } else {
              overflow = true;
            }
          }
        }
        prev = ch;
      }
      if (overflow && onOverflow)
        onOverflow();
      if (folds.length === 0)
        return text2;
      if (onFold)
        onFold();
      let res = text2.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text2.length;
        if (fold === 0)
          res = `
${indent}${text2.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text2[fold]}\\`;
          res += `
${indent}${text2.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text2, i, indent) {
      let end = i;
      let start = i + 1;
      let ch = text2[start];
      while (ch === " " || ch === "	") {
        if (i < start + indent) {
          ch = text2[++i];
        } else {
          do {
            ch = text2[++i];
          } while (ch && ch !== "\n");
          end = i;
          start = i + 1;
          ch = text2[start];
        }
      }
      return end;
    }
    exports.FOLD_BLOCK = FOLD_BLOCK;
    exports.FOLD_FLOW = FOLD_FLOW;
    exports.FOLD_QUOTED = FOLD_QUOTED;
    exports.foldFlowLines = foldFlowLines;
  }
});

// node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyString.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var foldFlowLines = require_foldFlowLines();
    var getFoldOptions = (ctx, isBlock) => ({
      indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
      lineWidth: ctx.options.lineWidth,
      minContentWidth: ctx.options.minContentWidth
    });
    var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
    function lineLengthOverLimit(str, lineWidth, indentLength) {
      if (!lineWidth || lineWidth < 0)
        return false;
      const limit = lineWidth - indentLength;
      const strLen = str.length;
      if (strLen <= limit)
        return false;
      for (let i = 0, start = 0; i < strLen; ++i) {
        if (str[i] === "\n") {
          if (i - start > limit)
            return true;
          start = i + 1;
          if (strLen - start <= limit)
            return false;
        }
      }
      return true;
    }
    function doubleQuotedString(value, ctx) {
      const json = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str = "";
      let start = 0;
      for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
        if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
          str += json.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json[i + 1]) {
            case "u":
              {
                str += json.slice(start, i);
                const code = json.substr(i + 2, 4);
                switch (code) {
                  case "0000":
                    str += "\\0";
                    break;
                  case "0007":
                    str += "\\a";
                    break;
                  case "000b":
                    str += "\\v";
                    break;
                  case "001b":
                    str += "\\e";
                    break;
                  case "0085":
                    str += "\\N";
                    break;
                  case "00a0":
                    str += "\\_";
                    break;
                  case "2028":
                    str += "\\L";
                    break;
                  case "2029":
                    str += "\\P";
                    break;
                  default:
                    if (code.substr(0, 2) === "00")
                      str += "\\x" + code.substr(2);
                    else
                      str += json.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json.slice(start, i) + "\n\n";
                while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent;
                if (json[i + 2] === " ")
                  str += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start ? str + json.slice(start) : json;
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    function singleQuotedString(value, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
        return doubleQuotedString(value, ctx);
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function quotedString(value, ctx) {
      const { singleQuote } = ctx.options;
      let qs;
      if (singleQuote === false)
        qs = doubleQuotedString;
      else {
        const hasDouble = value.includes('"');
        const hasSingle = value.includes("'");
        if (hasDouble && !hasSingle)
          qs = singleQuotedString;
        else if (hasSingle && !hasDouble)
          qs = doubleQuotedString;
        else
          qs = singleQuote ? singleQuotedString : doubleQuotedString;
      }
      return qs(value, ctx);
    }
    var blockEndNewlines;
    try {
      blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
    } catch {
      blockEndNewlines = /\n+(?!\n|$)/g;
    }
    function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
      const { blockQuote, commentString, lineWidth } = ctx.options;
      if (!blockQuote || /\n[\t ]+$/.test(value)) {
        return quotedString(value, ctx);
      }
      const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
      const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
      if (!value)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value.length; endStart > 0; --endStart) {
        const ch = value[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end = value.substring(endStart);
      const endNlPos = end.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value === end || endNlPos !== end.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end) {
        value = value.slice(0, -end.length);
        if (end[end.length - 1] === "\n")
          end = end.slice(0, -1);
        end = end.replace(blockEndNewlines, `$&${indent}`);
      }
      let startWithSpace = false;
      let startEnd;
      let startNlPos = -1;
      for (startEnd = 0; startEnd < value.length; ++startEnd) {
        const ch = value[startEnd];
        if (ch === " ")
          startWithSpace = true;
        else if (ch === "\n")
          startNlPos = startEnd;
        else
          break;
      }
      let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
      if (start) {
        value = value.substring(start.length);
        start = start.replace(/\n+/g, `$&${indent}`);
      }
      const indentSize = indent ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent}${body}`;
      }
      value = value.replace(/\n+/g, `$&${indent}`);
      return `|${header}
${indent}${start}${value}${end}`;
    }
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value } = item;
      const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
      if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
        return quotedString(value, ctx);
      }
      if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
        return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
      }
      if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes("\n")) {
        return blockString(item, ctx, onComment, onChompKeep);
      }
      if (containsDocumentMarker(value)) {
        if (indent === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent === indentStep) {
          return quotedString(value, ctx);
        }
      }
      const str = value.replace(/\n+/g, `$&
${indent}`);
      if (actualString) {
        const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value, ctx);
      }
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function stringifyString(item, ctx, onComment, onChompKeep) {
      const { implicitKey, inFlow } = ctx;
      const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
      let { type } = item;
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
          type = Scalar.Scalar.QUOTE_DOUBLE;
      }
      const _stringify = (_type) => {
        switch (_type) {
          case Scalar.Scalar.BLOCK_FOLDED:
          case Scalar.Scalar.BLOCK_LITERAL:
            return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
          case Scalar.Scalar.QUOTE_DOUBLE:
            return doubleQuotedString(ss.value, ctx);
          case Scalar.Scalar.QUOTE_SINGLE:
            return singleQuotedString(ss.value, ctx);
          case Scalar.Scalar.PLAIN:
            return plainString(ss, ctx, onComment, onChompKeep);
          default:
            return null;
        }
      };
      let res = _stringify(type);
      if (res === null) {
        const { defaultKeyType, defaultStringType } = ctx.options;
        const t = implicitKey && defaultKeyType || defaultStringType;
        res = _stringify(t);
        if (res === null)
          throw new Error(`Unsupported default string type ${t}`);
      }
      return res;
    }
    exports.stringifyString = stringifyString;
  }
});

// node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS({
  "node_modules/yaml/dist/stringify/stringify.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var identity = require_identity();
    var stringifyComment = require_stringifyComment();
    var stringifyString = require_stringifyString();
    function createStringifyContext(doc, options) {
      const opt = Object.assign({
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: "PLAIN",
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: "false",
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: "null",
        simpleKeys: false,
        singleQuote: null,
        trailingComma: false,
        trueStr: "true",
        verifyAliasOrder: true
      }, doc.schema.toStringOptions, options);
      let inFlow;
      switch (opt.collectionStyle) {
        case "block":
          inFlow = false;
          break;
        case "flow":
          inFlow = true;
          break;
        default:
          inFlow = null;
      }
      return {
        anchors: /* @__PURE__ */ new Set(),
        doc,
        flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
        indent: "",
        indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
        inFlow,
        options: opt
      };
    }
    function getTagObject(tags, item) {
      if (item.tag) {
        const match = tags.filter((t) => t.tag === item.tag);
        if (match.length > 0)
          return match.find((t) => t.format === item.format) ?? match[0];
      }
      let tagObj = void 0;
      let obj;
      if (identity.isScalar(item)) {
        obj = item.value;
        let match = tags.filter((t) => t.identify?.(obj));
        if (match.length > 1) {
          const testMatch = match.filter((t) => t.test);
          if (testMatch.length > 0)
            match = testMatch;
        }
        tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
      } else {
        obj = item;
        tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
      }
      if (!tagObj) {
        const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
        throw new Error(`Tag not resolved for ${name} value`);
      }
      return tagObj;
    }
    function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag)
        props.push(doc.directives.tagString(tag));
      return props.join(" ");
    }
    function stringify(item, ctx, onComment, onChompKeep) {
      if (identity.isPair(item))
        return item.toString(ctx, onComment, onChompKeep);
      if (identity.isAlias(item)) {
        if (ctx.doc.directives)
          return item.toString(ctx);
        if (ctx.resolvedAliases?.has(item)) {
          throw new TypeError(`Cannot stringify circular structure without alias nodes`);
        } else {
          if (ctx.resolvedAliases)
            ctx.resolvedAliases.add(item);
          else
            ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
          item = item.resolve(ctx.doc);
        }
      }
      let tagObj = void 0;
      const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
      const props = stringifyProps(node, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str;
      return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
    }
    exports.createStringifyContext = createStringifyContext;
    exports.stringify = stringify;
  }
});

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyPair.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
      let keyComment = identity.isNode(key) && key.comment || null;
      if (simpleKeys) {
        if (keyComment) {
          throw new Error("With simple keys, key nodes cannot have comments");
        }
        if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
          const msg = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg);
        }
      }
      let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
      ctx = Object.assign({}, ctx, {
        allNullValues: false,
        implicitKey: !explicitKey && (simpleKeys || !allNullValues),
        indent: indent + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
      if (!explicitKey && !ctx.inFlow && str.length > 1024) {
        if (simpleKeys)
          throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
        explicitKey = true;
      }
      if (ctx.inFlow) {
        if (allNullValues || value == null) {
          if (keyCommentDone && onComment)
            onComment();
          return str === "" ? "?" : explicitKey ? `? ${str}` : str;
        }
      } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
        str = `? ${str}`;
        if (keyComment && !keyCommentDone) {
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        } else if (chompKeep && onChompKeep)
          onChompKeep();
        return str;
      }
      if (keyCommentDone)
        keyComment = null;
      if (explicitKey) {
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        str = `? ${str}
${indent}:`;
      } else {
        str = `${str}:`;
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      }
      let vsb, vcb, valueComment;
      if (identity.isNode(value)) {
        vsb = !!value.spaceBefore;
        vcb = value.commentBefore;
        valueComment = value.comment;
      } else {
        vsb = false;
        vcb = null;
        valueComment = null;
        if (value && typeof value === "object")
          value = doc.createNode(value);
      }
      ctx.implicitKey = false;
      if (!explicitKey && !keyComment && identity.isScalar(value))
        ctx.indentAtStart = str.length + 1;
      chompKeep = false;
      if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
        ctx.indent = ctx.indent.substring(2);
      }
      let valueCommentDone = false;
      const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
      let ws = " ";
      if (keyComment || vsb || vcb) {
        ws = vsb ? "\n" : "";
        if (vcb) {
          const cs = commentString(vcb);
          ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
        }
        if (valueStr === "" && !ctx.inFlow) {
          if (ws === "\n" && valueComment)
            ws = "\n\n";
        } else {
          ws += `
${ctx.indent}`;
        }
      } else if (!explicitKey && identity.isCollection(value)) {
        const vs0 = valueStr[0];
        const nl0 = valueStr.indexOf("\n");
        const hasNewline = nl0 !== -1;
        const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
        if (hasNewline || !flow) {
          let hasPropsLine = false;
          if (hasNewline && (vs0 === "&" || vs0 === "!")) {
            let sp0 = valueStr.indexOf(" ");
            if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
              sp0 = valueStr.indexOf(" ", sp0 + 1);
            }
            if (sp0 === -1 || nl0 < sp0)
              hasPropsLine = true;
          }
          if (!hasPropsLine)
            ws = `
${ctx.indent}`;
        }
      } else if (valueStr === "" || valueStr[0] === "\n") {
        ws = "";
      }
      str += ws + valueStr;
      if (ctx.inFlow) {
        if (valueCommentDone && onComment)
          onComment();
      } else if (valueComment && !valueCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
      } else if (chompKeep && onChompKeep) {
        onChompKeep();
      }
      return str;
    }
    exports.stringifyPair = stringifyPair;
  }
});

// node_modules/yaml/dist/log.js
var require_log = __commonJS({
  "node_modules/yaml/dist/log.js"(exports) {
    "use strict";
    var node_process = __require("node:process");
    function debug(logLevel, ...messages) {
      if (logLevel === "debug")
        console.log(...messages);
    }
    function warn(logLevel, warning) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning);
        else
          console.warn(warning);
      }
    }
    exports.debug = debug;
    exports.warn = warn;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/merge.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var MERGE_KEY = "<<";
    var merge = {
      identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
      default: "key",
      tag: "tag:yaml.org,2002:merge",
      test: /^<<$/,
      resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap
      }),
      stringify: () => MERGE_KEY
    };
    var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
    function addMergeToJSMap(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (identity.isSeq(source))
        for (const it of source.items)
          mergeValue(ctx, map, it);
      else if (Array.isArray(source))
        for (const it of source)
          mergeValue(ctx, map, it);
      else
        mergeValue(ctx, map, source);
    }
    function mergeValue(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (!identity.isMap(source))
        throw new Error("Merge sources must be maps or map aliases");
      const srcMap = source.toJSON(null, ctx, Map);
      for (const [key, value2] of srcMap) {
        if (map instanceof Map) {
          if (!map.has(key))
            map.set(key, value2);
        } else if (map instanceof Set) {
          map.add(key);
        } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
          Object.defineProperty(map, key, {
            value: value2,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return map;
    }
    function resolveAliasValue(ctx, value) {
      return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
    }
    exports.addMergeToJSMap = addMergeToJSMap;
    exports.isMergeKey = isMergeKey;
    exports.merge = merge;
  }
});

// node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS({
  "node_modules/yaml/dist/nodes/addPairToJSMap.js"(exports) {
    "use strict";
    var log = require_log();
    var merge = require_merge();
    var stringify = require_stringify();
    var identity = require_identity();
    var toJS = require_toJS();
    function addPairToJSMap(ctx, map, { key, value }) {
      if (identity.isNode(key) && key.addToJSMap)
        key.addToJSMap(ctx, map, value);
      else if (merge.isMergeKey(ctx, key))
        merge.addMergeToJSMap(ctx, map, value);
      else {
        const jsKey = toJS.toJS(key, "", ctx);
        if (map instanceof Map) {
          map.set(jsKey, toJS.toJS(value, jsKey, ctx));
        } else if (map instanceof Set) {
          map.add(jsKey);
        } else {
          const stringKey = stringifyKey(key, jsKey, ctx);
          const jsValue = toJS.toJS(value, stringKey, ctx);
          if (stringKey in map)
            Object.defineProperty(map, stringKey, {
              value: jsValue,
              writable: true,
              enumerable: true,
              configurable: true
            });
          else
            map[stringKey] = jsValue;
        }
      }
      return map;
    }
    function stringifyKey(key, jsKey, ctx) {
      if (jsKey === null)
        return "";
      if (typeof jsKey !== "object")
        return String(jsKey);
      if (identity.isNode(key) && ctx?.doc) {
        const strCtx = stringify.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node of ctx.anchors.keys())
          strCtx.anchors.add(node.anchor);
        strCtx.inFlow = true;
        strCtx.inStringifyKey = true;
        const strKey = key.toString(strCtx);
        if (!ctx.mapKeyWarned) {
          let jsonStr = JSON.stringify(strKey);
          if (jsonStr.length > 40)
            jsonStr = jsonStr.substring(0, 36) + '..."';
          log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
          ctx.mapKeyWarned = true;
        }
        return strKey;
      }
      return JSON.stringify(jsKey);
    }
    exports.addPairToJSMap = addPairToJSMap;
  }
});

// node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS({
  "node_modules/yaml/dist/nodes/Pair.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyPair = require_stringifyPair();
    var addPairToJSMap = require_addPairToJSMap();
    var identity = require_identity();
    function createPair(key, value, ctx) {
      const k = createNode.createNode(key, void 0, ctx);
      const v = createNode.createNode(value, void 0, ctx);
      return new Pair(k, v);
    }
    var Pair = class _Pair {
      constructor(key, value = null) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
        this.key = key;
        this.value = value;
      }
      clone(schema) {
        let { key, value } = this;
        if (identity.isNode(key))
          key = key.clone(schema);
        if (identity.isNode(value))
          value = value.clone(schema);
        return new _Pair(key, value);
      }
      toJSON(_, ctx) {
        const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        return addPairToJSMap.addPairToJSMap(ctx, pair, this);
      }
      toString(ctx, onComment, onChompKeep) {
        return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
      }
    };
    exports.Pair = Pair;
    exports.createPair = createPair;
  }
});

// node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyCollection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify2(collection, ctx, options);
    }
    function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment2 = null;
        if (identity.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str2 = stringify.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines.push(blockItemPrefix + str2);
      }
      let str;
      if (lines.length === 0) {
        str = flowChars.start + flowChars.end;
      } else {
        str = lines[0];
        for (let i = 1; i < lines.length; ++i) {
          const line = lines[i];
          str += line ? `
${indent}${line}` : "\n";
        }
      }
      if (comment) {
        str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
      const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment = null;
        if (identity.isNode(item)) {
          if (item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, false);
            if (ik.comment)
              reqNewline = true;
          }
          const iv = identity.isNode(item.value) ? item.value : null;
          if (iv) {
            if (iv.comment)
              comment = iv.comment;
            if (iv.commentBefore)
              reqNewline = true;
          } else if (item.value == null && ik?.comment) {
            comment = ik.comment;
          }
        }
        if (comment)
          reqNewline = true;
        let str = stringify.stringify(item, itemCtx, () => comment = null);
        reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
        if (i < items.length - 1) {
          str += ",";
        } else if (ctx.options.trailingComma) {
          if (ctx.options.lineWidth > 0) {
            reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
          }
          if (reqNewline) {
            str += ",";
          }
        }
        if (comment)
          str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
        lines.push(str);
        linesAtValue = lines.length;
      }
      const { start, end } = flowChars;
      if (lines.length === 0) {
        return start + end;
      } else {
        if (!reqNewline) {
          const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str = start;
          for (const line of lines)
            str += line ? `
${indentStep}${indent}${line}` : "\n";
          return `${str}
${indent}${end}`;
        } else {
          return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
        }
      }
    }
    function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent);
        lines.push(ic.trimStart());
      }
    }
    exports.stringifyCollection = stringifyCollection;
  }
});

// node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLMap.js"(exports) {
    "use strict";
    var stringifyCollection = require_stringifyCollection();
    var addPairToJSMap = require_addPairToJSMap();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    function findPair(items, key) {
      const k = identity.isScalar(key) ? key.value : key;
      for (const it of items) {
        if (identity.isPair(it)) {
          if (it.key === key || it.key === k)
            return it;
          if (identity.isScalar(it.key) && it.key.value === k)
            return it;
        }
      }
      return void 0;
    }
    var YAMLMap = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:map";
      }
      constructor(schema) {
        super(identity.MAP, schema);
        this.items = [];
      }
      /**
       * A generic collection parsing method that can be extended
       * to other node classes that inherit from YAMLMap
       */
      static from(schema, obj, ctx) {
        const { keepUndefined, replacer } = ctx;
        const map = new this(schema);
        const add = (key, value) => {
          if (typeof replacer === "function")
            value = replacer.call(obj, key, value);
          else if (Array.isArray(replacer) && !replacer.includes(key))
            return;
          if (value !== void 0 || keepUndefined)
            map.items.push(Pair.createPair(key, value, ctx));
        };
        if (obj instanceof Map) {
          for (const [key, value] of obj)
            add(key, value);
        } else if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj))
            add(key, obj[key]);
        }
        if (typeof schema.sortMapEntries === "function") {
          map.items.sort(schema.sortMapEntries);
        }
        return map;
      }
      /**
       * Adds a value to the collection.
       *
       * @param overwrite - If not set `true`, using a key that is already in the
       *   collection will throw. Otherwise, overwrites the previous value.
       */
      add(pair, overwrite) {
        let _pair;
        if (identity.isPair(pair))
          _pair = pair;
        else if (!pair || typeof pair !== "object" || !("key" in pair)) {
          _pair = new Pair.Pair(pair, pair?.value);
        } else
          _pair = new Pair.Pair(pair.key, pair.value);
        const prev = findPair(this.items, _pair.key);
        const sortEntries = this.schema?.sortMapEntries;
        if (prev) {
          if (!overwrite)
            throw new Error(`Key ${_pair.key} already set`);
          if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
            prev.value.value = _pair.value;
          else
            prev.value = _pair.value;
        } else if (sortEntries) {
          const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
          if (i === -1)
            this.items.push(_pair);
          else
            this.items.splice(i, 0, _pair);
        } else {
          this.items.push(_pair);
        }
      }
      delete(key) {
        const it = findPair(this.items, key);
        if (!it)
          return false;
        const del = this.items.splice(this.items.indexOf(it), 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const it = findPair(this.items, key);
        const node = it?.value;
        return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
      }
      has(key) {
        return !!findPair(this.items, key);
      }
      set(key, value) {
        this.add(new Pair.Pair(key, value), true);
      }
      /**
       * @param ctx - Conversion context, originally set in Document#toJS()
       * @param {Class} Type - If set, forces the returned collection type
       * @returns Instance of Type, Map, or Object
       */
      toJSON(_, ctx, Type) {
        const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const item of this.items)
          addPairToJSMap.addPairToJSMap(ctx, map, item);
        return map;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        for (const item of this.items) {
          if (!identity.isPair(item))
            throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
        }
        if (!ctx.allNullValues && this.hasAllNullValues(false))
          ctx = Object.assign({}, ctx, { allNullValues: true });
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "",
          flowChars: { start: "{", end: "}" },
          itemIndent: ctx.indent || "",
          onChompKeep,
          onComment
        });
      }
    };
    exports.YAMLMap = YAMLMap;
    exports.findPair = findPair;
  }
});

// node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS({
  "node_modules/yaml/dist/schema/common/map.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLMap = require_YAMLMap();
    var map = {
      collection: "map",
      default: true,
      nodeClass: YAMLMap.YAMLMap,
      tag: "tag:yaml.org,2002:map",
      resolve(map2, onError) {
        if (!identity.isMap(map2))
          onError("Expected a mapping for this tag");
        return map2;
      },
      createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
    };
    exports.map = map;
  }
});

// node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLSeq.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyCollection = require_stringifyCollection();
    var Collection = require_Collection();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var toJS = require_toJS();
    var YAMLSeq = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:seq";
      }
      constructor(schema) {
        super(identity.SEQ, schema);
        this.items = [];
      }
      add(value) {
        this.items.push(value);
      }
      /**
       * Removes a value from the collection.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       *
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return false;
        const del = this.items.splice(idx, 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return void 0;
        const it = this.items[idx];
        return !keepScalar && identity.isScalar(it) ? it.value : it;
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       */
      has(key) {
        const idx = asItemIndex(key);
        return typeof idx === "number" && idx < this.items.length;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       *
       * If `key` does not contain a representation of an integer, this will throw.
       * It may be wrapped in a `Scalar`.
       */
      set(key, value) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          throw new Error(`Expected a valid index, not ${key}.`);
        const prev = this.items[idx];
        if (identity.isScalar(prev) && Scalar.isScalarValue(value))
          prev.value = value;
        else
          this.items[idx] = value;
      }
      toJSON(_, ctx) {
        const seq = [];
        if (ctx?.onCreate)
          ctx.onCreate(seq);
        let i = 0;
        for (const item of this.items)
          seq.push(toJS.toJS(item, String(i++), ctx));
        return seq;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: (ctx.indent || "") + "  ",
          onChompKeep,
          onComment
        });
      }
      static from(schema, obj, ctx) {
        const { replacer } = ctx;
        const seq = new this(schema);
        if (obj && Symbol.iterator in Object(obj)) {
          let i = 0;
          for (let it of obj) {
            if (typeof replacer === "function") {
              const key = obj instanceof Set ? it : String(i++);
              it = replacer.call(obj, key, it);
            }
            seq.items.push(createNode.createNode(it, void 0, ctx));
          }
        }
        return seq;
      }
    };
    function asItemIndex(key) {
      let idx = identity.isScalar(key) ? key.value : key;
      if (idx && typeof idx === "string")
        idx = Number(idx);
      return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
    }
    exports.YAMLSeq = YAMLSeq;
  }
});

// node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS({
  "node_modules/yaml/dist/schema/common/seq.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLSeq = require_YAMLSeq();
    var seq = {
      collection: "seq",
      default: true,
      nodeClass: YAMLSeq.YAMLSeq,
      tag: "tag:yaml.org,2002:seq",
      resolve(seq2, onError) {
        if (!identity.isSeq(seq2))
          onError("Expected a sequence for this tag");
        return seq2;
      },
      createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
    };
    exports.seq = seq;
  }
});

// node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS({
  "node_modules/yaml/dist/schema/common/string.js"(exports) {
    "use strict";
    var stringifyString = require_stringifyString();
    var string2 = {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports.string = string2;
  }
});

// node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS({
  "node_modules/yaml/dist/schema/common/null.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var nullTag = {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^(?:~|[Nn]ull|NULL)?$/,
      resolve: () => new Scalar.Scalar(null),
      stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
    };
    exports.nullTag = nullTag;
  }
});

// node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS({
  "node_modules/yaml/dist/schema/core/bool.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var boolTag = {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
      resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
      stringify({ source, value }, ctx) {
        if (source && boolTag.test.test(source)) {
          const sv = source[0] === "t" || source[0] === "T";
          if (value === sv)
            return source;
        }
        return value ? ctx.options.trueStr : ctx.options.falseStr;
      }
    };
    exports.boolTag = boolTag;
  }
});

// node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyNumber.js"(exports) {
    "use strict";
    function stringifyNumber({ format, minFractionDigits, tag, value }) {
      if (typeof value === "bigint")
        return String(value);
      const num = typeof value === "number" ? value : Number(value);
      if (!isFinite(num))
        return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
      let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
      if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
        let i = n.indexOf(".");
        if (i < 0) {
          i = n.length;
          n += ".";
        }
        let d = minFractionDigits - (n.length - i - 1);
        while (d-- > 0)
          n += "0";
      }
      return n;
    }
    exports.stringifyNumber = stringifyNumber;
  }
});

// node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS({
  "node_modules/yaml/dist/schema/core/float.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str));
        const dot = str.indexOf(".");
        if (dot !== -1 && str[str.length - 1] === "0")
          node.minFractionDigits = str.length - dot - 1;
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS({
  "node_modules/yaml/dist/schema/core/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value) && value >= 0)
        return prefix + value.toString(radix);
      return stringifyNumber.stringifyNumber(node);
    }
    var intOct = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
      stringify: (node) => intStringify(node, 8, "0o")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^0x[0-9a-fA-F]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports.int = int;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS({
  "node_modules/yaml/dist/schema/core/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string2 = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = [
      map.map,
      seq.seq,
      string2.string,
      _null.nullTag,
      bool.boolTag,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS({
  "node_modules/yaml/dist/schema/json/schema.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var map = require_map();
    var seq = require_seq();
    function intIdentify(value) {
      return typeof value === "bigint" || Number.isInteger(value);
    }
    var stringifyJSON = ({ value }) => JSON.stringify(value);
    var jsonScalars = [
      {
        identify: (value) => typeof value === "string",
        default: true,
        tag: "tag:yaml.org,2002:str",
        resolve: (str) => str,
        stringify: stringifyJSON
      },
      {
        identify: (value) => value == null,
        createNode: () => new Scalar.Scalar(null),
        default: true,
        tag: "tag:yaml.org,2002:null",
        test: /^null$/,
        resolve: () => null,
        stringify: stringifyJSON
      },
      {
        identify: (value) => typeof value === "boolean",
        default: true,
        tag: "tag:yaml.org,2002:bool",
        test: /^true$|^false$/,
        resolve: (str) => str === "true",
        stringify: stringifyJSON
      },
      {
        identify: intIdentify,
        default: true,
        tag: "tag:yaml.org,2002:int",
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
        stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
      },
      {
        identify: (value) => typeof value === "number",
        default: true,
        tag: "tag:yaml.org,2002:float",
        test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
        resolve: (str) => parseFloat(str),
        stringify: stringifyJSON
      }
    ];
    var jsonError = {
      default: true,
      tag: "",
      test: /^/,
      resolve(str, onError) {
        onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
        return str;
      }
    };
    var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/binary.js"(exports) {
    "use strict";
    var node_buffer = __require("node:buffer");
    var Scalar = require_Scalar();
    var stringifyString = require_stringifyString();
    var binary = {
      identify: (value) => value instanceof Uint8Array,
      // Buffer inherits from Uint8Array
      default: false,
      tag: "tag:yaml.org,2002:binary",
      /**
       * Returns a Buffer in node and an Uint8Array in browsers
       *
       * To use the resulting buffer as an image, you'll want to do something like:
       *
       *   const blob = new Blob([buffer], { type: 'image/jpeg' })
       *   document.querySelector('#photo').src = URL.createObjectURL(blob)
       */
      resolve(src, onError) {
        if (typeof node_buffer.Buffer === "function") {
          return node_buffer.Buffer.from(src, "base64");
        } else if (typeof atob === "function") {
          const str = atob(src.replace(/[\n\r]/g, ""));
          const buffer = new Uint8Array(str.length);
          for (let i = 0; i < str.length; ++i)
            buffer[i] = str.charCodeAt(i);
          return buffer;
        } else {
          onError("This environment does not support reading binary tags; either Buffer or atob is required");
          return src;
        }
      },
      stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
        if (!value)
          return "";
        const buf = value;
        let str;
        if (typeof node_buffer.Buffer === "function") {
          str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
        } else if (typeof btoa === "function") {
          let s = "";
          for (let i = 0; i < buf.length; ++i)
            s += String.fromCharCode(buf[i]);
          str = btoa(s);
        } else {
          throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
        }
        type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
        if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
          const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
          const n = Math.ceil(str.length / lineWidth);
          const lines = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines[i] = str.substr(o, lineWidth);
          }
          str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
        }
        return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
      }
    };
    exports.binary = binary;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/pairs.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLSeq = require_YAMLSeq();
    function resolvePairs(seq, onError) {
      if (identity.isSeq(seq)) {
        for (let i = 0; i < seq.items.length; ++i) {
          let item = seq.items[i];
          if (identity.isPair(item))
            continue;
          else if (identity.isMap(item)) {
            if (item.items.length > 1)
              onError("Each pair must have its own sequence indicator");
            const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
            if (item.commentBefore)
              pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
            if (item.comment) {
              const cn = pair.value ?? pair.key;
              cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
            }
            item = pair;
          }
          seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
        }
      } else
        onError("Expected a sequence for this tag");
      return seq;
    }
    function createPairs(schema, iterable, ctx) {
      const { replacer } = ctx;
      const pairs2 = new YAMLSeq.YAMLSeq(schema);
      pairs2.tag = "tag:yaml.org,2002:pairs";
      let i = 0;
      if (iterable && Symbol.iterator in Object(iterable))
        for (let it of iterable) {
          if (typeof replacer === "function")
            it = replacer.call(iterable, String(i++), it);
          let key, value;
          if (Array.isArray(it)) {
            if (it.length === 2) {
              key = it[0];
              value = it[1];
            } else
              throw new TypeError(`Expected [key, value] tuple: ${it}`);
          } else if (it && it instanceof Object) {
            const keys2 = Object.keys(it);
            if (keys2.length === 1) {
              key = keys2[0];
              value = it[key];
            } else {
              throw new TypeError(`Expected tuple with one key, not ${keys2.length} keys`);
            }
          } else {
            key = it;
          }
          pairs2.items.push(Pair.createPair(key, value, ctx));
        }
      return pairs2;
    }
    var pairs = {
      collection: "seq",
      default: false,
      tag: "tag:yaml.org,2002:pairs",
      resolve: resolvePairs,
      createNode: createPairs
    };
    exports.createPairs = createPairs;
    exports.pairs = pairs;
    exports.resolvePairs = resolvePairs;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/omap.js"(exports) {
    "use strict";
    var identity = require_identity();
    var toJS = require_toJS();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var pairs = require_pairs();
    var YAMLOMap = class _YAMLOMap extends YAMLSeq.YAMLSeq {
      constructor() {
        super();
        this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
        this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
        this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
        this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
        this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
        this.tag = _YAMLOMap.tag;
      }
      /**
       * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
       * but TypeScript won't allow widening the signature of a child method.
       */
      toJSON(_, ctx) {
        if (!ctx)
          return super.toJSON(_);
        const map = /* @__PURE__ */ new Map();
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const pair of this.items) {
          let key, value;
          if (identity.isPair(pair)) {
            key = toJS.toJS(pair.key, "", ctx);
            value = toJS.toJS(pair.value, key, ctx);
          } else {
            key = toJS.toJS(pair, "", ctx);
          }
          if (map.has(key))
            throw new Error("Ordered maps must not include duplicate keys");
          map.set(key, value);
        }
        return map;
      }
      static from(schema, iterable, ctx) {
        const pairs$1 = pairs.createPairs(schema, iterable, ctx);
        const omap2 = new this();
        omap2.items = pairs$1.items;
        return omap2;
      }
    };
    YAMLOMap.tag = "tag:yaml.org,2002:omap";
    var omap = {
      collection: "seq",
      identify: (value) => value instanceof Map,
      nodeClass: YAMLOMap,
      default: false,
      tag: "tag:yaml.org,2002:omap",
      resolve(seq, onError) {
        const pairs$1 = pairs.resolvePairs(seq, onError);
        const seenKeys = [];
        for (const { key } of pairs$1.items) {
          if (identity.isScalar(key)) {
            if (seenKeys.includes(key.value)) {
              onError(`Ordered maps must not include duplicate keys: ${key.value}`);
            } else {
              seenKeys.push(key.value);
            }
          }
        }
        return Object.assign(new YAMLOMap(), pairs$1);
      },
      createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
    };
    exports.YAMLOMap = YAMLOMap;
    exports.omap = omap;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/bool.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    function boolStringify({ value, source }, ctx) {
      const boolObj = value ? trueTag : falseTag;
      if (source && boolObj.test.test(source))
        return source;
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
    var trueTag = {
      identify: (value) => value === true,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
      resolve: () => new Scalar.Scalar(true),
      stringify: boolStringify
    };
    var falseTag = {
      identify: (value) => value === false,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
      resolve: () => new Scalar.Scalar(false),
      stringify: boolStringify
    };
    exports.falseTag = falseTag;
    exports.trueTag = trueTag;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/float.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str.replace(/_/g, "")),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
        const dot = str.indexOf(".");
        if (dot !== -1) {
          const f = str.substring(dot + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node.minFractionDigits = f.length;
        }
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    function intResolve(str, offset, radix, { intAsBigInt }) {
      const sign = str[0];
      if (sign === "-" || sign === "+")
        offset += 1;
      str = str.substring(offset).replace(/_/g, "");
      if (intAsBigInt) {
        switch (radix) {
          case 2:
            str = `0b${str}`;
            break;
          case 8:
            str = `0o${str}`;
            break;
          case 16:
            str = `0x${str}`;
            break;
        }
        const n2 = BigInt(str);
        return sign === "-" ? BigInt(-1) * n2 : n2;
      }
      const n = parseInt(str, radix);
      return sign === "-" ? -1 * n : n;
    }
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value)) {
        const str = value.toString(radix);
        return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
      }
      return stringifyNumber.stringifyNumber(node);
    }
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
      stringify: (node) => intStringify(node, 2, "0b")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
      stringify: (node) => intStringify(node, 8, "0")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9][0-9_]*$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^[-+]?0x[0-9a-fA-F_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports.int = int;
    exports.intBin = intBin;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/set.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSet = class _YAMLSet extends YAMLMap.YAMLMap {
      constructor(schema) {
        super(schema);
        this.tag = _YAMLSet.tag;
      }
      add(key) {
        let pair;
        if (identity.isPair(key))
          pair = key;
        else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
          pair = new Pair.Pair(key.key, null);
        else
          pair = new Pair.Pair(key, null);
        const prev = YAMLMap.findPair(this.items, pair.key);
        if (!prev)
          this.items.push(pair);
      }
      /**
       * If `keepPair` is `true`, returns the Pair matching `key`.
       * Otherwise, returns the value of that Pair's key.
       */
      get(key, keepPair) {
        const pair = YAMLMap.findPair(this.items, key);
        return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
      }
      set(key, value) {
        if (typeof value !== "boolean")
          throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
        const prev = YAMLMap.findPair(this.items, key);
        if (prev && !value) {
          this.items.splice(this.items.indexOf(prev), 1);
        } else if (!prev && value) {
          this.items.push(new Pair.Pair(key));
        }
      }
      toJSON(_, ctx) {
        return super.toJSON(_, ctx, Set);
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        if (this.hasAllNullValues(true))
          return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
        else
          throw new Error("Set items must all have null values");
      }
      static from(schema, iterable, ctx) {
        const { replacer } = ctx;
        const set2 = new this(schema);
        if (iterable && Symbol.iterator in Object(iterable))
          for (let value of iterable) {
            if (typeof replacer === "function")
              value = replacer.call(iterable, value, value);
            set2.items.push(Pair.createPair(value, null, ctx));
          }
        return set2;
      }
    };
    YAMLSet.tag = "tag:yaml.org,2002:set";
    var set = {
      collection: "map",
      identify: (value) => value instanceof Set,
      nodeClass: YAMLSet,
      default: false,
      tag: "tag:yaml.org,2002:set",
      createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
      resolve(map, onError) {
        if (identity.isMap(map)) {
          if (map.hasAllNullValues(true))
            return Object.assign(new YAMLSet(), map);
          else
            onError("Set items must all have null values");
        } else
          onError("Expected a mapping for this tag");
        return map;
      }
    };
    exports.YAMLSet = YAMLSet;
    exports.set = set;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/timestamp.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    function parseSexagesimal(str, asBigInt) {
      const sign = str[0];
      const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
      const num = (n) => asBigInt ? BigInt(n) : Number(n);
      const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
      return sign === "-" ? num(-1) * res : res;
    }
    function stringifySexagesimal(node) {
      let { value } = node;
      let num = (n) => n;
      if (typeof value === "bigint")
        num = (n) => BigInt(n);
      else if (isNaN(value) || !isFinite(value))
        return stringifyNumber.stringifyNumber(node);
      let sign = "";
      if (value < 0) {
        sign = "-";
        value *= num(-1);
      }
      const _60 = num(60);
      const parts = [value % _60];
      if (value < 60) {
        parts.unshift(0);
      } else {
        value = (value - parts[0]) / _60;
        parts.unshift(value % _60);
        if (value >= 60) {
          value = (value - parts[0]) / _60;
          parts.unshift(value);
        }
      }
      return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
    }
    var intTime = {
      identify: (value) => typeof value === "bigint" || Number.isInteger(value),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
      resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
      stringify: stringifySexagesimal
    };
    var floatTime = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
      resolve: (str) => parseSexagesimal(str, false),
      stringify: stringifySexagesimal
    };
    var timestamp2 = {
      identify: (value) => value instanceof Date,
      default: true,
      tag: "tag:yaml.org,2002:timestamp",
      // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
      // may be omitted altogether, resulting in a date format. In such a case, the time part is
      // assumed to be 00:00:00Z (start of day, UTC).
      test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
      resolve(str) {
        const match = str.match(timestamp2.test);
        if (!match)
          throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
        const [, year, month, day, hour, minute, second] = match.map(Number);
        const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
        let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
        const tz = match[8];
        if (tz && tz !== "Z") {
          let d = parseSexagesimal(tz, false);
          if (Math.abs(d) < 30)
            d *= 60;
          date -= 6e4 * d;
        }
        return new Date(date);
      },
      stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
    };
    exports.floatTime = floatTime;
    exports.intTime = intTime;
    exports.timestamp = timestamp2;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string2 = require_string();
    var binary = require_binary();
    var bool = require_bool2();
    var float = require_float2();
    var int = require_int2();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var set = require_set();
    var timestamp2 = require_timestamp();
    var schema = [
      map.map,
      seq.seq,
      string2.string,
      _null.nullTag,
      bool.trueTag,
      bool.falseTag,
      int.intBin,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float,
      binary.binary,
      merge.merge,
      omap.omap,
      pairs.pairs,
      set.set,
      timestamp2.intTime,
      timestamp2.floatTime,
      timestamp2.timestamp
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS({
  "node_modules/yaml/dist/schema/tags.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string2 = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = require_schema();
    var schema$1 = require_schema2();
    var binary = require_binary();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var schema$2 = require_schema3();
    var set = require_set();
    var timestamp2 = require_timestamp();
    var schemas = /* @__PURE__ */ new Map([
      ["core", schema.schema],
      ["failsafe", [map.map, seq.seq, string2.string]],
      ["json", schema$1.schema],
      ["yaml11", schema$2.schema],
      ["yaml-1.1", schema$2.schema]
    ]);
    var tagsByName = {
      binary: binary.binary,
      bool: bool.boolTag,
      float: float.float,
      floatExp: float.floatExp,
      floatNaN: float.floatNaN,
      floatTime: timestamp2.floatTime,
      int: int.int,
      intHex: int.intHex,
      intOct: int.intOct,
      intTime: timestamp2.intTime,
      map: map.map,
      merge: merge.merge,
      null: _null.nullTag,
      omap: omap.omap,
      pairs: pairs.pairs,
      seq: seq.seq,
      set: set.set,
      timestamp: timestamp2.timestamp
    };
    var coreKnownTags = {
      "tag:yaml.org,2002:binary": binary.binary,
      "tag:yaml.org,2002:merge": merge.merge,
      "tag:yaml.org,2002:omap": omap.omap,
      "tag:yaml.org,2002:pairs": pairs.pairs,
      "tag:yaml.org,2002:set": set.set,
      "tag:yaml.org,2002:timestamp": timestamp2.timestamp
    };
    function getTags(customTags, schemaName, addMergeTag) {
      const schemaTags = schemas.get(schemaName);
      if (schemaTags && !customTags) {
        return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
      }
      let tags = schemaTags;
      if (!tags) {
        if (Array.isArray(customTags))
          tags = [];
        else {
          const keys2 = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown schema "${schemaName}"; use one of ${keys2} or define customTags array`);
        }
      }
      if (Array.isArray(customTags)) {
        for (const tag of customTags)
          tags = tags.concat(tag);
      } else if (typeof customTags === "function") {
        tags = customTags(tags.slice());
      }
      if (addMergeTag)
        tags = tags.concat(merge.merge);
      return tags.reduce((tags2, tag) => {
        const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
        if (!tagObj) {
          const tagName = JSON.stringify(tag);
          const keys2 = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown custom tag ${tagName}; use one of ${keys2}`);
        }
        if (!tags2.includes(tagObj))
          tags2.push(tagObj);
        return tags2;
      }, []);
    }
    exports.coreKnownTags = coreKnownTags;
    exports.getTags = getTags;
  }
});

// node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS({
  "node_modules/yaml/dist/schema/Schema.js"(exports) {
    "use strict";
    var identity = require_identity();
    var map = require_map();
    var seq = require_seq();
    var string2 = require_string();
    var tags = require_tags();
    var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    var Schema = class _Schema {
      constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
        this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
        this.name = typeof schema === "string" && schema || "core";
        this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
        this.tags = tags.getTags(customTags, this.name, merge);
        this.toStringOptions = toStringDefaults ?? null;
        Object.defineProperty(this, identity.MAP, { value: map.map });
        Object.defineProperty(this, identity.SCALAR, { value: string2.string });
        Object.defineProperty(this, identity.SEQ, { value: seq.seq });
        this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
      }
      clone() {
        const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
      }
    };
    exports.Schema = Schema;
  }
});

// node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyDocument.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options) {
      const lines = [];
      let hasDirectives = options.directives === true;
      if (options.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines.push("---");
      const ctx = stringify.createStringifyContext(doc, options);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines.length !== 1)
          lines.unshift("");
        const cs = commentString(doc.commentBefore);
        lines.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
          lines[lines.length - 1] = `--- ${body}`;
        } else
          lines.push(body);
      } else {
        lines.push(stringify.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines.push("...");
            lines.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines.push(`... ${cs}`);
          }
        } else {
          lines.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
            lines.push("");
          lines.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines.join("\n") + "\n";
    }
    exports.stringifyDocument = stringifyDocument;
  }
});

// node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS({
  "node_modules/yaml/dist/doc/Document.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var toJS = require_toJS();
    var Schema = require_Schema();
    var stringifyDocument = require_stringifyDocument();
    var anchors = require_anchors();
    var applyReviver = require_applyReviver();
    var createNode = require_createNode();
    var directives = require_directives();
    var Document = class _Document {
      constructor(value, replacer, options) {
        this.commentBefore = null;
        this.comment = null;
        this.errors = [];
        this.warnings = [];
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
        let _replacer = null;
        if (typeof replacer === "function" || Array.isArray(replacer)) {
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const opt = Object.assign({
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: "warn",
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: "1.2"
        }, options);
        this.options = opt;
        let { version } = opt;
        if (options?._directives) {
          this.directives = options._directives.atDocument();
          if (this.directives.yaml.explicit)
            version = this.directives.yaml.version;
        } else
          this.directives = new directives.Directives({ version });
        this.setSchema(version, options);
        this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
      }
      /**
       * Create a deep copy of this Document and its contents.
       *
       * Custom Node values that inherit from `Object` still refer to their original instances.
       */
      clone() {
        const copy = Object.create(_Document.prototype, {
          [identity.NODE_TYPE]: { value: identity.DOC }
        });
        copy.commentBefore = this.commentBefore;
        copy.comment = this.comment;
        copy.errors = this.errors.slice();
        copy.warnings = this.warnings.slice();
        copy.options = Object.assign({}, this.options);
        if (this.directives)
          copy.directives = this.directives.clone();
        copy.schema = this.schema.clone();
        copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** Adds a value to the document. */
      add(value) {
        if (assertCollection(this.contents))
          this.contents.add(value);
      }
      /** Adds a value to the document. */
      addIn(path, value) {
        if (assertCollection(this.contents))
          this.contents.addIn(path, value);
      }
      /**
       * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
       *
       * If `node` already has an anchor, `name` is ignored.
       * Otherwise, the `node.anchor` value will be set to `name`,
       * or if an anchor with that name is already present in the document,
       * `name` will be used as a prefix for a new unique anchor.
       * If `name` is undefined, the generated anchor will use 'a' as a prefix.
       */
      createAlias(node, name) {
        if (!node.anchor) {
          const prev = anchors.anchorNames(this);
          node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node.anchor);
      }
      createNode(value, replacer, options) {
        let _replacer = void 0;
        if (typeof replacer === "function") {
          value = replacer.call({ "": value }, "", value);
          _replacer = replacer;
        } else if (Array.isArray(replacer)) {
          const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
          const asStr = replacer.filter(keyToStr).map(String);
          if (asStr.length > 0)
            replacer = replacer.concat(asStr);
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
        const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
          this,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          anchorPrefix || "a"
        );
        const ctx = {
          aliasDuplicateObjects: aliasDuplicateObjects ?? true,
          keepUndefined: keepUndefined ?? false,
          onAnchor,
          onTagObj,
          replacer: _replacer,
          schema: this.schema,
          sourceObjects
        };
        const node = createNode.createNode(value, tag, ctx);
        if (flow && identity.isCollection(node))
          node.flow = true;
        setAnchors();
        return node;
      }
      /**
       * Convert a key and a value into a `Pair` using the current schema,
       * recursively wrapping all values as `Scalar` or `Collection` nodes.
       */
      createPair(key, value, options = {}) {
        const k = this.createNode(key, null, options);
        const v = this.createNode(value, null, options);
        return new Pair.Pair(k, v);
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        return assertCollection(this.contents) ? this.contents.delete(key) : false;
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        if (Collection.isEmptyPath(path)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      get(key, keepScalar) {
        return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
      }
      /**
       * Returns item at `path`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        if (Collection.isEmptyPath(path))
          return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
      }
      /**
       * Checks if the document includes a value with the key `key`.
       */
      has(key) {
        return identity.isCollection(this.contents) ? this.contents.has(key) : false;
      }
      /**
       * Checks if the document includes a value at `path`.
       */
      hasIn(path) {
        if (Collection.isEmptyPath(path))
          return this.contents !== void 0;
        return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      set(key, value) {
        if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, [key], value);
        } else if (assertCollection(this.contents)) {
          this.contents.set(key, value);
        }
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        if (Collection.isEmptyPath(path)) {
          this.contents = value;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path, value);
        }
      }
      /**
       * Change the YAML version and schema used by the document.
       * A `null` version disables support for directives, explicit tags, anchors, and aliases.
       * It also requires the `schema` option to be given as a `Schema` instance value.
       *
       * Overrides all previously set schema options.
       */
      setSchema(version, options = {}) {
        if (typeof version === "number")
          version = String(version);
        let opt;
        switch (version) {
          case "1.1":
            if (this.directives)
              this.directives.yaml.version = "1.1";
            else
              this.directives = new directives.Directives({ version: "1.1" });
            opt = { resolveKnownTags: false, schema: "yaml-1.1" };
            break;
          case "1.2":
          case "next":
            if (this.directives)
              this.directives.yaml.version = version;
            else
              this.directives = new directives.Directives({ version });
            opt = { resolveKnownTags: true, schema: "core" };
            break;
          case null:
            if (this.directives)
              delete this.directives;
            opt = null;
            break;
          default: {
            const sv = JSON.stringify(version);
            throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
          }
        }
        if (options.schema instanceof Object)
          this.schema = options.schema;
        else if (opt)
          this.schema = new Schema.Schema(Object.assign(opt, options));
        else
          throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
      }
      // json & jsonArg are only used from toJSON()
      toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
      /**
       * A JSON representation of the document `contents`.
       *
       * @param jsonArg Used by `JSON.stringify` to indicate the array index or
       *   property name.
       */
      toJSON(jsonArg, onAnchor) {
        return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
      }
      /** A YAML representation of the document. */
      toString(options = {}) {
        if (this.errors.length > 0)
          throw new Error("Document with errors cannot be stringified");
        if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
          const s = JSON.stringify(options.indent);
          throw new Error(`"indent" option must be a positive integer, not ${s}`);
        }
        return stringifyDocument.stringifyDocument(this, options);
      }
    };
    function assertCollection(contents) {
      if (identity.isCollection(contents))
        return true;
      throw new Error("Expected a YAML collection as document contents");
    }
    exports.Document = Document;
  }
});

// node_modules/yaml/dist/errors.js
var require_errors = __commonJS({
  "node_modules/yaml/dist/errors.js"(exports) {
    "use strict";
    var YAMLError = class extends Error {
      constructor(name, pos, code, message) {
        super();
        this.name = name;
        this.code = code;
        this.message = message;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLParseError", pos, code, message);
      }
    };
    var YAMLWarning = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLWarning", pos, code, message);
      }
    };
    var prettifyError = (src, lc) => (error) => {
      if (error.pos[0] === -1)
        return;
      error.linePos = error.pos.map((pos) => lc.linePos(pos));
      const { line, col } = error.linePos[0];
      error.message += ` at line ${line}, column ${col}`;
      let ci = col - 1;
      let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
      if (ci >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci - 39, lineStr.length - 79);
        lineStr = "\u2026" + lineStr.substring(trimStart);
        ci -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "\u2026";
      if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
        let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "\u2026\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count = 1;
        const end = error.linePos[1];
        if (end?.line === line && end.col > col) {
          count = Math.max(1, Math.min(end.col - col, 80 - ci));
        }
        const pointer = " ".repeat(ci) + "^".repeat(count);
        error.message += `:

${lineStr}
${pointer}
`;
      }
    };
    exports.YAMLError = YAMLError;
    exports.YAMLParseError = YAMLParseError;
    exports.YAMLWarning = YAMLWarning;
    exports.prettifyError = prettifyError;
  }
});

// node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS({
  "node_modules/yaml/dist/compose/resolve-props.js"(exports) {
    "use strict";
    function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
      let spaceBefore = false;
      let atNewline = startOnNewline;
      let hasSpace = startOnNewline;
      let comment = "";
      let commentSep = "";
      let hasNewline = false;
      let reqSpace = false;
      let tab = null;
      let anchor = null;
      let tag = null;
      let newlineAfterProp = null;
      let comma = null;
      let found = null;
      let start = null;
      for (const token3 of tokens) {
        if (reqSpace) {
          if (token3.type !== "space" && token3.type !== "newline" && token3.type !== "comma")
            onError(token3.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
          reqSpace = false;
        }
        if (tab) {
          if (atNewline && token3.type !== "comment" && token3.type !== "newline") {
            onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
          }
          tab = null;
        }
        switch (token3.type) {
          case "space":
            if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token3.source.includes("	")) {
              tab = token3;
            }
            hasSpace = true;
            break;
          case "comment": {
            if (!hasSpace)
              onError(token3, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = token3.source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += commentSep + cb;
            commentSep = "";
            atNewline = false;
            break;
          }
          case "newline":
            if (atNewline) {
              if (comment)
                comment += token3.source;
              else if (!found || indicator !== "seq-item-ind")
                spaceBefore = true;
            } else
              commentSep += token3.source;
            atNewline = true;
            hasNewline = true;
            if (anchor || tag)
              newlineAfterProp = token3;
            hasSpace = true;
            break;
          case "anchor":
            if (anchor)
              onError(token3, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
            if (token3.source.endsWith(":"))
              onError(token3.offset + token3.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
            anchor = token3;
            start ?? (start = token3.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          case "tag": {
            if (tag)
              onError(token3, "MULTIPLE_TAGS", "A node can have at most one tag");
            tag = token3;
            start ?? (start = token3.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          }
          case indicator:
            if (anchor || tag)
              onError(token3, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token3.source} indicator`);
            if (found)
              onError(token3, "UNEXPECTED_TOKEN", `Unexpected ${token3.source} in ${flow ?? "collection"}`);
            found = token3;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow) {
              if (comma)
                onError(token3, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
              comma = token3;
              atNewline = false;
              hasSpace = false;
              break;
            }
          // else fallthrough
          default:
            onError(token3, "UNEXPECTED_TOKEN", `Unexpected ${token3.type} token`);
            atNewline = false;
            hasSpace = false;
        }
      }
      const last = tokens[tokens.length - 1];
      const end = last ? last.offset + last.source.length : offset;
      if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
        onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      }
      if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      return {
        comma,
        found,
        spaceBefore,
        comment,
        hasNewline,
        anchor,
        tag,
        newlineAfterProp,
        end,
        start: start ?? end
      };
    }
    exports.resolveProps = resolveProps;
  }
});

// node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS({
  "node_modules/yaml/dist/compose/util-contains-newline.js"(exports) {
    "use strict";
    function containsNewline(key) {
      if (!key)
        return null;
      switch (key.type) {
        case "alias":
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          if (key.source.includes("\n"))
            return true;
          if (key.end) {
            for (const st of key.end)
              if (st.type === "newline")
                return true;
          }
          return false;
        case "flow-collection":
          for (const it of key.items) {
            for (const st of it.start)
              if (st.type === "newline")
                return true;
            if (it.sep) {
              for (const st of it.sep)
                if (st.type === "newline")
                  return true;
            }
            if (containsNewline(it.key) || containsNewline(it.value))
              return true;
          }
          return false;
        default:
          return true;
      }
    }
    exports.containsNewline = containsNewline;
  }
});

// node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS({
  "node_modules/yaml/dist/compose/util-flow-indent-check.js"(exports) {
    "use strict";
    var utilContainsNewline = require_util_contains_newline();
    function flowIndentCheck(indent, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end = fc.end[0];
        if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg, true);
        }
      }
    }
    exports.flowIndentCheck = flowIndentCheck;
  }
});

// node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS({
  "node_modules/yaml/dist/compose/util-map-includes.js"(exports) {
    "use strict";
    var identity = require_identity();
    function mapIncludes(ctx, items, search) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
      return items.some((pair) => isEqual(pair.key, search));
    }
    exports.mapIncludes = mapIncludes;
  }
});

// node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-map.js"(exports) {
    "use strict";
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    var utilMapIncludes = require_util_map_includes();
    var startColMsg = "All mapping items must start at the same column";
    function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
      const map = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      let offset = bm.offset;
      let commentEnd = null;
      for (const collItem of bm.items) {
        const { start, key, sep: sep3, value } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep3?.[0],
          offset,
          onError,
          parentIndent: bm.indent,
          startOnNewline: true
        });
        const implicitKey = !keyProps.found;
        if (implicitKey) {
          if (key) {
            if (key.type === "block-seq")
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
            else if ("indent" in key && key.indent !== bm.indent)
              onError(offset, "BAD_INDENT", startColMsg);
          }
          if (!keyProps.anchor && !keyProps.tag && !sep3) {
            commentEnd = keyProps.end;
            if (keyProps.comment) {
              if (map.comment)
                map.comment += "\n" + keyProps.comment;
              else
                map.comment = keyProps.comment;
            }
            continue;
          }
          if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
            onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
          }
        } else if (keyProps.found?.indent !== bm.indent) {
          onError(offset, "BAD_INDENT", startColMsg);
        }
        ctx.atKey = true;
        const keyStart = keyProps.end;
        const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
        ctx.atKey = false;
        if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        const valueProps = resolveProps.resolveProps(sep3 ?? [], {
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: bm.indent,
          startOnNewline: !key || key.type === "block-scalar"
        });
        offset = valueProps.end;
        if (valueProps.found) {
          if (implicitKey) {
            if (value?.type === "block-map" && !valueProps.hasNewline)
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
              onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep3, null, valueProps, onError);
          if (ctx.schema.compat)
            utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
          offset = valueNode.range[2];
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        } else {
          if (implicitKey)
            onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
          if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        }
      }
      if (commentEnd && commentEnd < offset)
        onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
      map.range = [bm.offset, offset, commentEnd ?? offset];
      return map;
    }
    exports.resolveBlockMap = resolveBlockMap;
  }
});

// node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-seq.js"(exports) {
    "use strict";
    var YAMLSeq = require_YAMLSeq();
    var resolveProps = require_resolve_props();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
      const seq = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = bs.offset;
      let commentEnd = null;
      for (const { start, value } of bs.items) {
        const props = resolveProps.resolveProps(start, {
          indicator: "seq-item-ind",
          next: value,
          offset,
          onError,
          parentIndent: bs.indent,
          startOnNewline: true
        });
        if (!props.found) {
          if (props.anchor || props.tag || value) {
            if (value?.type === "block-seq")
              onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
            else
              onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
          } else {
            commentEnd = props.end;
            if (props.comment)
              seq.comment = props.comment;
            continue;
          }
        }
        const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
        offset = node.range[2];
        seq.items.push(node);
      }
      seq.range = [bs.offset, offset, commentEnd ?? offset];
      return seq;
    }
    exports.resolveBlockSeq = resolveBlockSeq;
  }
});

// node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS({
  "node_modules/yaml/dist/compose/resolve-end.js"(exports) {
    "use strict";
    function resolveEnd(end, offset, reqSpace, onError) {
      let comment = "";
      if (end) {
        let hasSpace = false;
        let sep3 = "";
        for (const token3 of end) {
          const { source, type } = token3;
          switch (type) {
            case "space":
              hasSpace = true;
              break;
            case "comment": {
              if (reqSpace && !hasSpace)
                onError(token3, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
              const cb = source.substring(1) || " ";
              if (!comment)
                comment = cb;
              else
                comment += sep3 + cb;
              sep3 = "";
              break;
            }
            case "newline":
              if (comment)
                sep3 += source;
              hasSpace = true;
              break;
            default:
              onError(token3, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
          }
          offset += source.length;
        }
      }
      return { comment, offset };
    }
    exports.resolveEnd = resolveEnd;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilMapIncludes = require_util_map_includes();
    var blockMsg = "Block collections are not allowed within flow collections";
    var isBlock = (token3) => token3 && (token3.type === "block-map" || token3.type === "block-seq");
    function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
      const isMap2 = fc.start.source === "{";
      const fcName = isMap2 ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap2 ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
      const coll = new NodeClass(ctx.schema);
      coll.flow = true;
      const atRoot = ctx.atRoot;
      if (atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = fc.offset + fc.start.source.length;
      for (let i = 0; i < fc.items.length; ++i) {
        const collItem = fc.items[i];
        const { start, key, sep: sep3, value } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep3?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep3 && !value) {
            if (i === 0 && props.comma)
              onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
            else if (i < fc.items.length - 1)
              onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
            if (props.comment) {
              if (coll.comment)
                coll.comment += "\n" + props.comment;
              else
                coll.comment = props.comment;
            }
            offset = props.end;
            continue;
          }
          if (!isMap2 && ctx.options.strict && utilContainsNewline.containsNewline(key))
            onError(
              key,
              // checked by containsNewline()
              "MULTILINE_IMPLICIT_KEY",
              "Implicit keys of flow sequence pairs need to be on a single line"
            );
        }
        if (i === 0) {
          if (props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        } else {
          if (!props.comma)
            onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
          if (props.comment) {
            let prevItemComment = "";
            loop: for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
            if (prevItemComment) {
              let prev = coll.items[coll.items.length - 1];
              if (identity.isPair(prev))
                prev = prev.value ?? prev.key;
              if (prev.comment)
                prev.comment += "\n" + prevItemComment;
              else
                prev.comment = prevItemComment;
              props.comment = props.comment.substring(prevItemComment.length + 1);
            }
          }
        }
        if (!isMap2 && !sep3 && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep3, null, props, onError);
          coll.items.push(valueNode);
          offset = valueNode.range[2];
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else {
          ctx.atKey = true;
          const keyStart = props.end;
          const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
          if (isBlock(key))
            onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
          ctx.atKey = false;
          const valueProps = resolveProps.resolveProps(sep3 ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap2 && !props.found && ctx.options.strict) {
              if (sep3)
                for (const st of sep3) {
                  if (st === valueProps.found)
                    break;
                  if (st.type === "newline") {
                    onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                    break;
                  }
                }
              if (props.start < valueProps.found.offset - 1024)
                onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
            }
          } else if (value) {
            if ("source" in value && value.source?.[0] === ":")
              onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
            else
              onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep3, null, valueProps, onError) : null;
          if (valueNode) {
            if (isBlock(value))
              onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
          } else if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          if (isMap2) {
            const map = coll;
            if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
              onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
            map.items.push(pair);
          } else {
            const map = new YAMLMap.YAMLMap(ctx.schema);
            map.flow = true;
            map.items.push(pair);
            const endRange = (valueNode ?? keyNode).range;
            map.range = [keyNode.range[0], endRange[1], endRange[2]];
            coll.items.push(map);
          }
          offset = valueNode ? valueNode.range[2] : valueProps.end;
        }
      }
      const expectedEnd = isMap2 ? "}" : "]";
      const [ce, ...ee] = fc.end;
      let cePos = offset;
      if (ce?.source === expectedEnd)
        cePos = ce.offset + ce.source.length;
      else {
        const name = fcName[0].toUpperCase() + fcName.substring(1);
        const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
        if (ce && ce.source.length !== 1)
          ee.unshift(ce);
      }
      if (ee.length > 0) {
        const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end.comment) {
          if (coll.comment)
            coll.comment += "\n" + end.comment;
          else
            coll.comment = end.comment;
        }
        coll.range = [fc.offset, cePos, end.offset];
      } else {
        coll.range = [fc.offset, cePos, cePos];
      }
      return coll;
    }
    exports.resolveFlowCollection = resolveFlowCollection;
  }
});

// node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS({
  "node_modules/yaml/dist/compose/compose-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveBlockMap = require_resolve_block_map();
    var resolveBlockSeq = require_resolve_block_seq();
    var resolveFlowCollection = require_resolve_flow_collection();
    function resolveCollection(CN, ctx, token3, onError, tagName, tag) {
      const coll = token3.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token3, onError, tag) : token3.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token3, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token3, onError, tag);
      const Coll = coll.constructor;
      if (tagName === "!" || tagName === Coll.tagName) {
        coll.tag = Coll.tagName;
        return coll;
      }
      if (tagName)
        coll.tag = tagName;
      return coll;
    }
    function composeCollection(CN, ctx, token3, props, onError) {
      const tagToken = props.tag;
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
      if (token3.type === "block-seq") {
        const { anchor, newlineAfterProp: nl } = props;
        const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
        if (lastProp && (!nl || nl.offset < lastProp.offset)) {
          const message = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message);
        }
      }
      const expType = token3.type === "block-map" ? "map" : token3.type === "block-seq" ? "seq" : token3.start.source === "{" ? "map" : "seq";
      if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
        return resolveCollection(CN, ctx, token3, onError, tagName);
      }
      let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
      if (!tag) {
        const kt = ctx.schema.knownTags[tagName];
        if (kt?.collection === expType) {
          ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
          tag = kt;
        } else {
          if (kt) {
            onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
          } else {
            onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
          }
          return resolveCollection(CN, ctx, token3, onError, tagName);
        }
      }
      const coll = resolveCollection(CN, ctx, token3, onError, tagName, tag);
      const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
      const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
      node.range = coll.range;
      node.tag = tagName;
      if (tag?.format)
        node.format = tag.format;
      return node;
    }
    exports.composeCollection = composeCollection;
  }
});

// node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-scalar.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    function resolveBlockScalar(ctx, scalar, onError) {
      const start = scalar.offset;
      const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
      if (!header)
        return { value: "", type: null, comment: "", range: [start, start, start] };
      const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
      const lines = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines.length;
      for (let i = lines.length - 1; i >= 0; --i) {
        const content = lines[i][1];
        if (content === "" || content === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
        let end2 = start + header.length;
        if (scalar.source)
          end2 += scalar.source.length;
        return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent, content] = lines[i];
        if (content === "" || content === "\r") {
          if (header.indent === 0 && indent.length > trimIndent)
            trimIndent = indent.length;
        } else {
          if (indent.length < trimIndent) {
            const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent.length, "MISSING_CHAR", message);
          }
          if (header.indent === 0)
            trimIndent = indent.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message);
          }
          break;
        }
        offset += indent.length + content.length + 1;
      }
      for (let i = lines.length - 1; i >= chompStart; --i) {
        if (lines[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value = "";
      let sep3 = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value += lines[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent, content] = lines[i];
        offset += indent.length + content.length + 1;
        const crlf = content[content.length - 1] === "\r";
        if (crlf)
          content = content.slice(0, -1);
        if (content && indent.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
          indent = "";
        }
        if (type === Scalar.Scalar.BLOCK_LITERAL) {
          value += sep3 + indent.slice(trimIndent) + content;
          sep3 = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep3 === " ")
            sep3 = "\n";
          else if (!prevMoreIndented && sep3 === "\n")
            sep3 = "\n\n";
          value += sep3 + indent.slice(trimIndent) + content;
          sep3 = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep3 === "\n")
            value += "\n";
          else
            sep3 = "\n";
        } else {
          value += sep3 + content;
          sep3 = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines.length; ++i)
            value += "\n" + lines[i][0].slice(trimIndent);
          if (value[value.length - 1] !== "\n")
            value += "\n";
          break;
        default:
          value += "\n";
      }
      const end = start + header.length + scalar.source.length;
      return { value, type, comment: header.comment, range: [start, end, end] };
    }
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent = 0;
      let chomp = "";
      let error = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent && n)
            indent = n;
          else if (error === -1)
            error = offset + i;
        }
      }
      if (error !== -1)
        onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
      let hasSpace = false;
      let comment = "";
      let length = source.length;
      for (let i = 1; i < props.length; ++i) {
        const token3 = props[i];
        switch (token3.type) {
          case "space":
            hasSpace = true;
          // fallthrough
          case "newline":
            length += token3.source.length;
            break;
          case "comment":
            if (strict && !hasSpace) {
              const message = "Comments must be separated from other tokens by white space characters";
              onError(token3, "MISSING_CHAR", message);
            }
            length += token3.source.length;
            comment = token3.source.substring(1);
            break;
          case "error":
            onError(token3, "UNEXPECTED_TOKEN", token3.message);
            length += token3.source.length;
            break;
          /* istanbul ignore next should not happen */
          default: {
            const message = `Unexpected token in block scalar header: ${token3.type}`;
            onError(token3, "UNEXPECTED_TOKEN", message);
            const ts = token3.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent, chomp, comment, length };
    }
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first = split[0];
      const m = first.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
      const lines = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines.push([split[i], split[i + 1]]);
      return lines;
    }
    exports.resolveBlockScalar = resolveBlockScalar;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-scalar.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var resolveEnd = require_resolve_end();
    function resolveFlowScalar(scalar, strict, onError) {
      const { offset, type, source, end } = scalar;
      let _type;
      let value;
      const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
      switch (type) {
        case "scalar":
          _type = Scalar.Scalar.PLAIN;
          value = plainValue(source, _onError);
          break;
        case "single-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_SINGLE;
          value = singleQuotedValue(source, _onError);
          break;
        case "double-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_DOUBLE;
          value = doubleQuotedValue(source, _onError);
          break;
        /* istanbul ignore next should not happen */
        default:
          onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
          return {
            value: "",
            type: null,
            comment: "",
            range: [offset, offset + source.length, offset + source.length]
          };
      }
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
      return {
        value,
        type: _type,
        comment: re.comment,
        range: [offset, valueEnd, re.offset]
      };
    }
    function plainValue(source, onError) {
      let badChar = "";
      switch (source[0]) {
        /* istanbul ignore next should not happen */
        case "	":
          badChar = "a tab character";
          break;
        case ",":
          badChar = "flow indicator character ,";
          break;
        case "%":
          badChar = "directive indicator character %";
          break;
        case "|":
        case ">": {
          badChar = `block scalar indicator ${source[0]}`;
          break;
        }
        case "@":
        case "`": {
          badChar = `reserved character ${source[0]}`;
          break;
        }
      }
      if (badChar)
        onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
      return foldLines(source);
    }
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return foldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    function foldLines(source) {
      let first, line;
      try {
        first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
        line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
      } catch {
        first = /(.*?)[ \t]*\r?\n/sy;
        line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
      }
      let match = first.exec(source);
      if (!match)
        return source;
      let res = match[1];
      let sep3 = " ";
      let pos = first.lastIndex;
      line.lastIndex = pos;
      while (match = line.exec(source)) {
        if (match[1] === "") {
          if (sep3 === "\n")
            res += sep3;
          else
            sep3 = "\n";
        } else {
          res += sep3 + match[1];
          sep3 = " ";
        }
        pos = line.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep3 + (match?.[1] ?? "");
    }
    function doubleQuotedValue(source, onError) {
      let res = "";
      for (let i = 1; i < source.length - 1; ++i) {
        const ch = source[i];
        if (ch === "\r" && source[i + 1] === "\n")
          continue;
        if (ch === "\n") {
          const { fold, offset } = foldNewline(source, i);
          res += fold;
          i = offset;
        } else if (ch === "\\") {
          let next = source[++i];
          const cc = escapeCodes[next];
          if (cc)
            res += cc;
          else if (next === "\n") {
            next = source[i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "\r" && source[i + 1] === "\n") {
            next = source[++i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "x" || next === "u" || next === "U") {
            const length = next === "x" ? 2 : next === "u" ? 4 : 8;
            res += parseCharCode(source, i + 1, length, onError);
            i += length;
          } else {
            const raw = source.substr(i - 1, 2);
            onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
            res += raw;
          }
        } else if (ch === " " || ch === "	") {
          const wsStart = i;
          let next = source[i + 1];
          while (next === " " || next === "	")
            next = source[++i + 1];
          if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
            res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
        } else {
          res += ch;
        }
      }
      if (source[source.length - 1] !== '"' || source.length === 1)
        onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
      return res;
    }
    function foldNewline(source, offset) {
      let fold = "";
      let ch = source[offset + 1];
      while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[offset + 2] !== "\n")
          break;
        if (ch === "\n")
          fold += "\n";
        offset += 1;
        ch = source[offset + 1];
      }
      if (!fold)
        fold = " ";
      return { fold, offset };
    }
    var escapeCodes = {
      "0": "\0",
      // null character
      a: "\x07",
      // bell character
      b: "\b",
      // backspace
      e: "\x1B",
      // escape character
      f: "\f",
      // form feed
      n: "\n",
      // line feed
      r: "\r",
      // carriage return
      t: "	",
      // horizontal tab
      v: "\v",
      // vertical tab
      N: "\x85",
      // Unicode next line
      _: "\xA0",
      // Unicode non-breaking space
      L: "\u2028",
      // Unicode line separator
      P: "\u2029",
      // Unicode paragraph separator
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      "	": "	"
    };
    function parseCharCode(source, offset, length, onError) {
      const cc = source.substr(offset, length);
      const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code = ok ? parseInt(cc, 16) : NaN;
      try {
        return String.fromCodePoint(code);
      } catch {
        const raw = source.substr(offset - 2, length + 2);
        onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        return raw;
      }
    }
    exports.resolveFlowScalar = resolveFlowScalar;
  }
});

// node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS({
  "node_modules/yaml/dist/compose/compose-scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    function composeScalar(ctx, token3, tagToken, onError) {
      const { value, type, comment, range } = token3.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token3, onError) : resolveFlowScalar.resolveFlowScalar(token3, ctx.options.strict, onError);
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
      let tag;
      if (ctx.options.stringKeys && ctx.atKey) {
        tag = ctx.schema[identity.SCALAR];
      } else if (tagName)
        tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
      else if (token3.type === "scalar")
        tag = findScalarTagByTest(ctx, value, token3, onError);
      else
        tag = ctx.schema[identity.SCALAR];
      let scalar;
      try {
        const res = tag.resolve(value, (msg) => onError(tagToken ?? token3, "TAG_RESOLVE_FAILED", msg), ctx.options);
        scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        onError(tagToken ?? token3, "TAG_RESOLVE_FAILED", msg);
        scalar = new Scalar.Scalar(value);
      }
      scalar.range = range;
      scalar.source = value;
      if (type)
        scalar.type = type;
      if (tagName)
        scalar.tag = tagName;
      if (tag.format)
        scalar.format = tag.format;
      if (comment)
        scalar.comment = comment;
      return scalar;
    }
    function findScalarTagByName(schema, value, tagName, tagToken, onError) {
      if (tagName === "!")
        return schema[identity.SCALAR];
      const matchWithTest = [];
      for (const tag of schema.tags) {
        if (!tag.collection && tag.tag === tagName) {
          if (tag.default && tag.test)
            matchWithTest.push(tag);
          else
            return tag;
        }
      }
      for (const tag of matchWithTest)
        if (tag.test?.test(value))
          return tag;
      const kt = schema.knownTags[tagName];
      if (kt && !kt.collection) {
        schema.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
        return kt;
      }
      onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
      return schema[identity.SCALAR];
    }
    function findScalarTagByTest({ atKey, directives, schema }, value, token3, onError) {
      const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
      if (schema.compat) {
        const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
        if (tag.tag !== compat.tag) {
          const ts = directives.tagString(tag.tag);
          const cs = directives.tagString(compat.tag);
          const msg = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token3, "TAG_RESOLVE_FAILED", msg, true);
        }
      }
      return tag;
    }
    exports.composeScalar = composeScalar;
  }
});

// node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS({
  "node_modules/yaml/dist/compose/util-empty-scalar-position.js"(exports) {
    "use strict";
    function emptyScalarPosition(offset, before, pos) {
      if (before) {
        pos ?? (pos = before.length);
        for (let i = pos - 1; i >= 0; --i) {
          let st = before[i];
          switch (st.type) {
            case "space":
            case "comment":
            case "newline":
              offset -= st.source.length;
              continue;
          }
          st = before[++i];
          while (st?.type === "space") {
            offset += st.source.length;
            st = before[++i];
          }
          break;
        }
      }
      return offset;
    }
    exports.emptyScalarPosition = emptyScalarPosition;
  }
});

// node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS({
  "node_modules/yaml/dist/compose/compose-node.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var composeCollection = require_compose_collection();
    var composeScalar = require_compose_scalar();
    var resolveEnd = require_resolve_end();
    var utilEmptyScalarPosition = require_util_empty_scalar_position();
    var CN = { composeNode, composeEmptyNode };
    function composeNode(ctx, token3, props, onError) {
      const atKey = ctx.atKey;
      const { spaceBefore, comment, anchor, tag } = props;
      let node;
      let isSrcToken = true;
      switch (token3.type) {
        case "alias":
          node = composeAlias(ctx, token3, onError);
          if (anchor || tag)
            onError(token3, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node = composeScalar.composeScalar(ctx, token3, tag, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          try {
            node = composeCollection.composeCollection(CN, ctx, token3, props, onError);
            if (anchor)
              node.anchor = anchor.source.substring(1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onError(token3, "RESOURCE_EXHAUSTION", message);
          }
          break;
        default: {
          const message = token3.type === "error" ? token3.message : `Unsupported token (type: ${token3.type})`;
          onError(token3, "UNEXPECTED_TOKEN", message);
          isSrcToken = false;
        }
      }
      node ?? (node = composeEmptyNode(ctx, token3.offset, void 0, null, props, onError));
      if (anchor && node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
        const msg = "With stringKeys, all keys must be strings";
        onError(tag ?? token3, "NON_STRING_KEY", msg);
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        if (token3.type === "scalar" && token3.source === "")
          node.comment = comment;
        else
          node.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node.srcToken = token3;
      return node;
    }
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
      const token3 = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node = composeScalar.composeScalar(ctx, token3, tag, onError);
      if (anchor) {
        node.anchor = anchor.source.substring(1);
        if (node.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        node.comment = comment;
        node.range[2] = end;
      }
      return node;
    }
    function composeAlias({ options }, { offset, source, end }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
      alias.range = [offset, valueEnd, re.offset];
      if (re.comment)
        alias.comment = re.comment;
      return alias;
    }
    exports.composeEmptyNode = composeEmptyNode;
    exports.composeNode = composeNode;
  }
});

// node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS({
  "node_modules/yaml/dist/compose/compose-doc.js"(exports) {
    "use strict";
    var Document = require_Document();
    var composeNode = require_compose_node();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    function composeDoc(options, directives, { offset, start, value, end }, onError) {
      const opts = Object.assign({ _directives: directives }, options);
      const doc = new Document.Document(void 0, opts);
      const ctx = {
        atKey: false,
        atRoot: true,
        directives: doc.directives,
        options: doc.options,
        schema: doc.schema
      };
      const props = resolveProps.resolveProps(start, {
        indicator: "doc-start",
        next: value ?? end?.[0],
        offset,
        onError,
        parentIndent: 0,
        startOnNewline: true
      });
      if (props.found) {
        doc.directives.docStart = true;
        if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
          onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
      }
      doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
      const contentEnd = doc.contents.range[2];
      const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
      if (re.comment)
        doc.comment = re.comment;
      doc.range = [offset, contentEnd, re.offset];
      return doc;
    }
    exports.composeDoc = composeDoc;
  }
});

// node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS({
  "node_modules/yaml/dist/compose/composer.js"(exports) {
    "use strict";
    var node_process = __require("node:process");
    var directives = require_directives();
    var Document = require_Document();
    var errors = require_errors();
    var identity = require_identity();
    var composeDoc = require_compose_doc();
    var resolveEnd = require_resolve_end();
    function getErrorPos(src) {
      if (typeof src === "number")
        return [src, src + 1];
      if (Array.isArray(src))
        return src.length === 2 ? src : [src[0], src[1]];
      const { offset, source } = src;
      return [offset, offset + (typeof source === "string" ? source.length : 1)];
    }
    function parsePrelude(prelude) {
      let comment = "";
      let atComment = false;
      let afterEmptyLine = false;
      for (let i = 0; i < prelude.length; ++i) {
        const source = prelude[i];
        switch (source[0]) {
          case "#":
            comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
            atComment = true;
            afterEmptyLine = false;
            break;
          case "%":
            if (prelude[i + 1]?.[0] !== "#")
              i += 1;
            atComment = false;
            break;
          default:
            if (!atComment)
              afterEmptyLine = true;
            atComment = false;
        }
      }
      return { comment, afterEmptyLine };
    }
    var Composer = class {
      constructor(options = {}) {
        this.doc = null;
        this.atDirectives = false;
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
        this.onError = (source, code, message, warning) => {
          const pos = getErrorPos(source);
          if (warning)
            this.warnings.push(new errors.YAMLWarning(pos, code, message));
          else
            this.errors.push(new errors.YAMLParseError(pos, code, message));
        };
        this.directives = new directives.Directives({ version: options.version || "1.2" });
        this.options = options;
      }
      decorate(doc, afterDoc) {
        const { comment, afterEmptyLine } = parsePrelude(this.prelude);
        if (comment) {
          const dc = doc.contents;
          if (afterDoc) {
            doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
          } else if (afterEmptyLine || doc.directives.docStart || !dc) {
            doc.commentBefore = comment;
          } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
            let it = dc.items[0];
            if (identity.isPair(it))
              it = it.key;
            const cb = it.commentBefore;
            it.commentBefore = cb ? `${comment}
${cb}` : comment;
          } else {
            const cb = dc.commentBefore;
            dc.commentBefore = cb ? `${comment}
${cb}` : comment;
          }
        }
        if (afterDoc) {
          for (let i = 0; i < this.errors.length; ++i)
            doc.errors.push(this.errors[i]);
          for (let i = 0; i < this.warnings.length; ++i)
            doc.warnings.push(this.warnings[i]);
        } else {
          doc.errors = this.errors;
          doc.warnings = this.warnings;
        }
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
      }
      /**
       * Current stream status information.
       *
       * Mostly useful at the end of input for an empty stream.
       */
      streamInfo() {
        return {
          comment: parsePrelude(this.prelude).comment,
          directives: this.directives,
          errors: this.errors,
          warnings: this.warnings
        };
      }
      /**
       * Compose tokens into documents.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *compose(tokens, forceDoc = false, endOffset = -1) {
        for (const token3 of tokens)
          yield* this.next(token3);
        yield* this.end(forceDoc, endOffset);
      }
      /** Advance the composer by one CST token. */
      *next(token3) {
        if (node_process.env.LOG_STREAM)
          console.dir(token3, { depth: null });
        switch (token3.type) {
          case "directive":
            this.directives.add(token3.source, (offset, message, warning) => {
              const pos = getErrorPos(token3);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message, warning);
            });
            this.prelude.push(token3.source);
            this.atDirectives = true;
            break;
          case "document": {
            const doc = composeDoc.composeDoc(this.options, this.directives, token3, this.onError);
            if (this.atDirectives && !doc.directives.docStart)
              this.onError(token3, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
            this.decorate(doc, false);
            if (this.doc)
              yield this.doc;
            this.doc = doc;
            this.atDirectives = false;
            break;
          }
          case "byte-order-mark":
          case "space":
            break;
          case "comment":
          case "newline":
            this.prelude.push(token3.source);
            break;
          case "error": {
            const msg = token3.source ? `${token3.message}: ${JSON.stringify(token3.source)}` : token3.message;
            const error = new errors.YAMLParseError(getErrorPos(token3), "UNEXPECTED_TOKEN", msg);
            if (this.atDirectives || !this.doc)
              this.errors.push(error);
            else
              this.doc.errors.push(error);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token3), "UNEXPECTED_TOKEN", msg));
              break;
            }
            this.doc.directives.docEnd = true;
            const end = resolveEnd.resolveEnd(token3.end, token3.offset + token3.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
            }
            this.doc.range[2] = end.offset;
            break;
          }
          default:
            this.errors.push(new errors.YAMLParseError(getErrorPos(token3), "UNEXPECTED_TOKEN", `Unsupported token ${token3.type}`));
        }
      }
      /**
       * Call at end of input to yield any remaining document.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *end(forceDoc = false, endOffset = -1) {
        if (this.doc) {
          this.decorate(this.doc, true);
          yield this.doc;
          this.doc = null;
        } else if (forceDoc) {
          const opts = Object.assign({ _directives: this.directives }, this.options);
          const doc = new Document.Document(void 0, opts);
          if (this.atDirectives)
            this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
          doc.range = [0, endOffset, endOffset];
          this.decorate(doc, false);
          yield doc;
        }
      }
    };
    exports.Composer = Composer;
  }
});

// node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS({
  "node_modules/yaml/dist/parse/cst-scalar.js"(exports) {
    "use strict";
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    var errors = require_errors();
    var stringifyString = require_stringifyString();
    function resolveAsScalar(token3, strict = true, onError) {
      if (token3) {
        const _onError = (pos, code, message) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code, message);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code, message);
        };
        switch (token3.type) {
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return resolveFlowScalar.resolveFlowScalar(token3, strict, _onError);
          case "block-scalar":
            return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token3, _onError);
        }
      }
      return null;
    }
    function createScalarToken(value, context) {
      const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey,
        indent: indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end = context.end ?? [
        { type: "newline", offset: -1, indent, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head = source.substring(0, he);
          const body = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent, source: head }
          ];
          if (!addEndtoBlockProps(props, end))
            props.push({ type: "newline", offset: -1, indent, source: "\n" });
          return { type: "block-scalar", offset, indent, props, source: body };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent, source, end };
        case "'":
          return { type: "single-quoted-scalar", offset, indent, source, end };
        default:
          return { type: "scalar", offset, indent, source, end };
      }
    }
    function setScalarValue(token3, value, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent = "indent" in token3 ? token3.indent : null;
      if (afterKey && typeof indent === "number")
        indent += 2;
      if (!type)
        switch (token3.type) {
          case "single-quoted-scalar":
            type = "QUOTE_SINGLE";
            break;
          case "double-quoted-scalar":
            type = "QUOTE_DOUBLE";
            break;
          case "block-scalar": {
            const header = token3.props[0];
            if (header.type !== "block-scalar-header")
              throw new Error("Invalid block scalar header");
            type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
            break;
          }
          default:
            type = "PLAIN";
        }
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey: implicitKey || indent === null,
        indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      switch (source[0]) {
        case "|":
        case ">":
          setBlockScalarValue(token3, source);
          break;
        case '"':
          setFlowScalarValue(token3, source, "double-quoted-scalar");
          break;
        case "'":
          setFlowScalarValue(token3, source, "single-quoted-scalar");
          break;
        default:
          setFlowScalarValue(token3, source, "scalar");
      }
    }
    function setBlockScalarValue(token3, source) {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      if (token3.type === "block-scalar") {
        const header = token3.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head;
        token3.source = body;
      } else {
        const { offset } = token3;
        const indent = "indent" in token3 ? token3.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, "end" in token3 ? token3.end : void 0))
          props.push({ type: "newline", offset: -1, indent, source: "\n" });
        for (const key of Object.keys(token3))
          if (key !== "type" && key !== "offset")
            delete token3[key];
        Object.assign(token3, { type: "block-scalar", indent, props, source: body });
      }
    }
    function addEndtoBlockProps(props, end) {
      if (end)
        for (const st of end)
          switch (st.type) {
            case "space":
            case "comment":
              props.push(st);
              break;
            case "newline":
              props.push(st);
              return true;
          }
      return false;
    }
    function setFlowScalarValue(token3, source, type) {
      switch (token3.type) {
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          token3.type = type;
          token3.source = source;
          break;
        case "block-scalar": {
          const end = token3.props.slice(1);
          let oa = source.length;
          if (token3.props[0].type === "block-scalar-header")
            oa -= token3.props[0].source.length;
          for (const tok of end)
            tok.offset += oa;
          delete token3.props;
          Object.assign(token3, { type, source, end });
          break;
        }
        case "block-map":
        case "block-seq": {
          const offset = token3.offset + source.length;
          const nl = { type: "newline", offset, indent: token3.indent, source: "\n" };
          delete token3.items;
          Object.assign(token3, { type, source, end: [nl] });
          break;
        }
        default: {
          const indent = "indent" in token3 ? token3.indent : -1;
          const end = "end" in token3 && Array.isArray(token3.end) ? token3.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token3))
            if (key !== "type" && key !== "offset")
              delete token3[key];
          Object.assign(token3, { type, indent, source, end });
        }
      }
    }
    exports.createScalarToken = createScalarToken;
    exports.resolveAsScalar = resolveAsScalar;
    exports.setScalarValue = setScalarValue;
  }
});

// node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS({
  "node_modules/yaml/dist/parse/cst-stringify.js"(exports) {
    "use strict";
    var stringify = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
    function stringifyToken(token3) {
      switch (token3.type) {
        case "block-scalar": {
          let res = "";
          for (const tok of token3.props)
            res += stringifyToken(tok);
          return res + token3.source;
        }
        case "block-map":
        case "block-seq": {
          let res = "";
          for (const item of token3.items)
            res += stringifyItem(item);
          return res;
        }
        case "flow-collection": {
          let res = token3.start.source;
          for (const item of token3.items)
            res += stringifyItem(item);
          for (const st of token3.end)
            res += st.source;
          return res;
        }
        case "document": {
          let res = stringifyItem(token3);
          if (token3.end)
            for (const st of token3.end)
              res += st.source;
          return res;
        }
        default: {
          let res = token3.source;
          if ("end" in token3 && token3.end)
            for (const st of token3.end)
              res += st.source;
          return res;
        }
      }
    }
    function stringifyItem({ start, key, sep: sep3, value }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep3)
        for (const st of sep3)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    exports.stringify = stringify;
  }
});

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "node_modules/yaml/dist/parse/cst-visit.js"(exports) {
    "use strict";
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove item");
    function visit2(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit2.BREAK = BREAK;
    visit2.SKIP = SKIP;
    visit2.REMOVE = REMOVE;
    visit2.itemAtPath = (cst, path) => {
      let item = cst;
      for (const [field2, index] of path) {
        const tok = item?.[field2];
        if (tok && "items" in tok) {
          item = tok.items[index];
        } else
          return void 0;
      }
      return item;
    };
    visit2.parentCollection = (cst, path) => {
      const parent = visit2.itemAtPath(cst, path.slice(0, -1));
      const field2 = path[path.length - 1][0];
      const coll = parent?.[field2];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path, item, visitor) {
      let ctrl = visitor(item, path);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field2 of ["key", "value"]) {
        const token3 = item[field2];
        if (token3 && "items" in token3) {
          for (let i = 0; i < token3.items.length; ++i) {
            const ci = _visit(Object.freeze(path.concat([[field2, i]])), token3.items[i], visitor);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              token3.items.splice(i, 1);
              i -= 1;
            }
          }
          if (typeof ctrl === "function" && field2 === "key")
            ctrl = ctrl(item, path);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
    }
    exports.visit = visit2;
  }
});

// node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "node_modules/yaml/dist/parse/cst.js"(exports) {
    "use strict";
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection2 = (token3) => !!token3 && "items" in token3;
    var isScalar2 = (token3) => !!token3 && (token3.type === "scalar" || token3.type === "single-quoted-scalar" || token3.type === "double-quoted-scalar" || token3.type === "block-scalar");
    function prettyToken(token3) {
      switch (token3) {
        case BOM:
          return "<BOM>";
        case DOCUMENT:
          return "<DOC>";
        case FLOW_END:
          return "<FLOW_END>";
        case SCALAR:
          return "<SCALAR>";
        default:
          return JSON.stringify(token3);
      }
    }
    function tokenType(source) {
      switch (source) {
        case BOM:
          return "byte-order-mark";
        case DOCUMENT:
          return "doc-mode";
        case FLOW_END:
          return "flow-error-end";
        case SCALAR:
          return "scalar";
        case "---":
          return "doc-start";
        case "...":
          return "doc-end";
        case "":
        case "\n":
        case "\r\n":
          return "newline";
        case "-":
          return "seq-item-ind";
        case "?":
          return "explicit-key-ind";
        case ":":
          return "map-value-ind";
        case "{":
          return "flow-map-start";
        case "}":
          return "flow-map-end";
        case "[":
          return "flow-seq-start";
        case "]":
          return "flow-seq-end";
        case ",":
          return "comma";
      }
      switch (source[0]) {
        case " ":
        case "	":
          return "space";
        case "#":
          return "comment";
        case "%":
          return "directive-line";
        case "*":
          return "alias";
        case "&":
          return "anchor";
        case "!":
          return "tag";
        case "'":
          return "single-quoted-scalar";
        case '"':
          return "double-quoted-scalar";
        case "|":
        case ">":
          return "block-scalar-header";
      }
      return null;
    }
    exports.createScalarToken = cstScalar.createScalarToken;
    exports.resolveAsScalar = cstScalar.resolveAsScalar;
    exports.setScalarValue = cstScalar.setScalarValue;
    exports.stringify = cstStringify.stringify;
    exports.visit = cstVisit.visit;
    exports.BOM = BOM;
    exports.DOCUMENT = DOCUMENT;
    exports.FLOW_END = FLOW_END;
    exports.SCALAR = SCALAR;
    exports.isCollection = isCollection2;
    exports.isScalar = isScalar2;
    exports.prettyToken = prettyToken;
    exports.tokenType = tokenType;
  }
});

// node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS({
  "node_modules/yaml/dist/parse/lexer.js"(exports) {
    "use strict";
    var cst = require_cst();
    function isEmpty(ch) {
      switch (ch) {
        case void 0:
        case " ":
        case "\n":
        case "\r":
        case "	":
          return true;
        default:
          return false;
      }
    }
    var hexDigits = new Set("0123456789ABCDEFabcdef");
    var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
    var flowIndicatorChars = new Set(",[]{}");
    var invalidAnchorChars = new Set(" ,[]{}\n\r	");
    var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
    var Lexer = class {
      constructor() {
        this.atEnd = false;
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        this.buffer = "";
        this.flowKey = false;
        this.flowLevel = 0;
        this.indentNext = 0;
        this.indentValue = 0;
        this.lineEndPos = null;
        this.next = null;
        this.pos = 0;
      }
      /**
       * Generate YAML tokens from the `source` string. If `incomplete`,
       * a part of the last line may be left as a buffer for the next call.
       *
       * @returns A generator of lexical tokens
       */
      *lex(source, incomplete = false) {
        if (source) {
          if (typeof source !== "string")
            throw TypeError("source is not a string");
          this.buffer = this.buffer ? this.buffer + source : source;
          this.lineEndPos = null;
        }
        this.atEnd = !incomplete;
        let next = this.next ?? "stream";
        while (next && (incomplete || this.hasChars(1)))
          next = yield* this.parseNext(next);
      }
      atLineEnd() {
        let i = this.pos;
        let ch = this.buffer[i];
        while (ch === " " || ch === "	")
          ch = this.buffer[++i];
        if (!ch || ch === "#" || ch === "\n")
          return true;
        if (ch === "\r")
          return this.buffer[i + 1] === "\n";
        return false;
      }
      charAt(n) {
        return this.buffer[this.pos + n];
      }
      continueScalar(offset) {
        let ch = this.buffer[offset];
        if (this.indentNext > 0) {
          let indent = 0;
          while (ch === " ")
            ch = this.buffer[++indent + offset];
          if (ch === "\r") {
            const next = this.buffer[indent + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent + 1;
          }
          return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end = this.lineEndPos;
        if (typeof end !== "number" || end !== -1 && end < this.pos) {
          end = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end;
        }
        if (end === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end - 1] === "\r")
          end -= 1;
        return this.buffer.substring(this.pos, end);
      }
      hasChars(n) {
        return this.pos + n <= this.buffer.length;
      }
      setNext(state) {
        this.buffer = this.buffer.substring(this.pos);
        this.pos = 0;
        this.lineEndPos = null;
        this.next = state;
        return null;
      }
      peek(n) {
        return this.buffer.substr(this.pos, n);
      }
      *parseNext(next) {
        switch (next) {
          case "stream":
            return yield* this.parseStream();
          case "line-start":
            return yield* this.parseLineStart();
          case "block-start":
            return yield* this.parseBlockStart();
          case "doc":
            return yield* this.parseDocument();
          case "flow":
            return yield* this.parseFlowCollection();
          case "quoted-scalar":
            return yield* this.parseQuotedScalar();
          case "block-scalar":
            return yield* this.parseBlockScalar();
          case "plain-scalar":
            return yield* this.parsePlainScalar();
        }
      }
      *parseStream() {
        let line = this.getLine();
        if (line === null)
          return this.setNext("stream");
        if (line[0] === cst.BOM) {
          yield* this.pushCount(1);
          line = line.substring(1);
        }
        if (line[0] === "%") {
          let dirEnd = line.length;
          let cs = line.indexOf("#");
          while (cs !== -1) {
            const ch = line[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - sp);
          yield* this.pushNewline();
          return "stream";
        }
        yield cst.DOCUMENT;
        return yield* this.parseLineStart();
      }
      *parseLineStart() {
        const ch = this.charAt(0);
        if (!ch && !this.atEnd)
          return this.setNext("line-start");
        if (ch === "-" || ch === ".") {
          if (!this.atEnd && !this.hasChars(4))
            return this.setNext("line-start");
          const s = this.peek(3);
          if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
            yield* this.pushCount(3);
            this.indentValue = 0;
            this.indentNext = 0;
            return s === "---" ? "doc" : "stream";
          }
        }
        this.indentValue = yield* this.pushSpaces(false);
        if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
          this.indentNext = this.indentValue;
        return yield* this.parseBlockStart();
      }
      *parseBlockStart() {
        const [ch0, ch1] = this.peek(2);
        if (!ch1 && !this.atEnd)
          return this.setNext("block-start");
        if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
          const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
          this.indentNext = this.indentValue + 1;
          this.indentValue += n;
          return "block-start";
        }
        return "doc";
      }
      *parseDocument() {
        yield* this.pushSpaces(true);
        const line = this.getLine();
        if (line === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line[n]) {
          case "#":
            yield* this.pushCount(line.length - n);
          // fallthrough
          case void 0:
            yield* this.pushNewline();
            return yield* this.parseLineStart();
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel = 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            return "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "doc";
          case '"':
          case "'":
            return yield* this.parseQuotedScalar();
          case "|":
          case ">":
            n += yield* this.parseBlockScalarHeader();
            n += yield* this.pushSpaces(true);
            yield* this.pushCount(line.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line = this.getLine();
        if (line === null)
          return this.setNext("flow");
        if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
          const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line.length - n);
            return "flow";
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel += 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            this.flowKey = true;
            this.flowLevel -= 1;
            return this.flowLevel ? "flow" : "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "flow";
          case '"':
          case "'":
            this.flowKey = true;
            return yield* this.parseQuotedScalar();
          case ":": {
            const next = this.charAt(1);
            if (this.flowKey || isEmpty(next) || next === ",") {
              this.flowKey = false;
              yield* this.pushCount(1);
              yield* this.pushSpaces(true);
              return "flow";
            }
          }
          // fallthrough
          default:
            this.flowKey = false;
            return yield* this.parsePlainScalar();
        }
      }
      *parseQuotedScalar() {
        const quote = this.charAt(0);
        let end = this.buffer.indexOf(quote, this.pos + 1);
        if (quote === "'") {
          while (end !== -1 && this.buffer[end + 1] === "'")
            end = this.buffer.indexOf("'", end + 2);
        } else {
          while (end !== -1) {
            let n = 0;
            while (this.buffer[end - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end = this.buffer.indexOf('"', end + 1);
          }
        }
        const qb = this.buffer.substring(0, end);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end = this.buffer.length;
        }
        yield* this.pushToIndex(end + 1, false);
        return this.flowLevel ? "flow" : "doc";
      }
      *parseBlockScalarHeader() {
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        let i = this.pos;
        while (true) {
          const ch = this.buffer[++i];
          if (ch === "+")
            this.blockScalarKeep = true;
          else if (ch > "0" && ch <= "9")
            this.blockScalarIndent = Number(ch) - 1;
          else if (ch !== "-")
            break;
        }
        return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
      }
      *parseBlockScalar() {
        let nl = this.pos - 1;
        let indent = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case "\n":
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === "\n")
                break;
            }
            // fallthrough
            default:
              break loop;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("block-scalar");
        if (indent >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent;
          else {
            this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
          }
          do {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = this.buffer.indexOf("\n", cs);
          } while (nl !== -1);
          if (nl === -1) {
            if (!this.atEnd)
              return this.setNext("block-scalar");
            nl = this.buffer.length;
          }
        }
        let i = nl + 1;
        ch = this.buffer[i];
        while (ch === " ")
          ch = this.buffer[++i];
        if (ch === "	") {
          while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
            ch = this.buffer[++i];
          nl = i - 1;
        } else if (!this.blockScalarKeep) {
          do {
            let i2 = nl - 1;
            let ch2 = this.buffer[i2];
            if (ch2 === "\r")
              ch2 = this.buffer[--i2];
            const lastChar = i2;
            while (ch2 === " ")
              ch2 = this.buffer[--i2];
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
              nl = i2;
            else
              break;
          } while (true);
        }
        yield cst.SCALAR;
        yield* this.pushToIndex(nl + 1, true);
        return yield* this.parseLineStart();
      }
      *parsePlainScalar() {
        const inFlow = this.flowLevel > 0;
        let end = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end = i;
          } else if (isEmpty(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end = i;
            }
            if (next === "#" || inFlow && flowIndicatorChars.has(next))
              break;
            if (ch === "\n") {
              const cs = this.continueScalar(i + 1);
              if (cs === -1)
                break;
              i = Math.max(i, cs - 2);
            }
          } else {
            if (inFlow && flowIndicatorChars.has(ch))
              break;
            end = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end + 1, true);
        return inFlow ? "flow" : "doc";
      }
      *pushCount(n) {
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos += n;
          return n;
        }
        return 0;
      }
      *pushToIndex(i, allowEmpty) {
        const s = this.buffer.slice(this.pos, i);
        if (s) {
          yield s;
          this.pos += s.length;
          return s.length;
        } else if (allowEmpty)
          yield "";
        return 0;
      }
      *pushIndicators() {
        let n = 0;
        loop: while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            // this is an error
            case "?":
            // this is an error outside flow collections
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
        return n;
      }
      *pushTag() {
        if (this.charAt(1) === "<") {
          let i = this.pos + 2;
          let ch = this.buffer[i];
          while (!isEmpty(ch) && ch !== ">")
            ch = this.buffer[++i];
          return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
        } else {
          let i = this.pos + 1;
          let ch = this.buffer[i];
          while (ch) {
            if (tagChars.has(ch))
              ch = this.buffer[++i];
            else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
              ch = this.buffer[i += 3];
            } else
              break;
          }
          return yield* this.pushToIndex(i, false);
        }
      }
      *pushNewline() {
        const ch = this.buffer[this.pos];
        if (ch === "\n")
          return yield* this.pushCount(1);
        else if (ch === "\r" && this.charAt(1) === "\n")
          return yield* this.pushCount(2);
        else
          return 0;
      }
      *pushSpaces(allowTabs) {
        let i = this.pos - 1;
        let ch;
        do {
          ch = this.buffer[++i];
        } while (ch === " " || allowTabs && ch === "	");
        const n = i - this.pos;
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos = i;
        }
        return n;
      }
      *pushUntil(test) {
        let i = this.pos;
        let ch = this.buffer[i];
        while (!test(ch))
          ch = this.buffer[++i];
        return yield* this.pushToIndex(i, false);
      }
    };
    exports.Lexer = Lexer;
  }
});

// node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS({
  "node_modules/yaml/dist/parse/line-counter.js"(exports) {
    "use strict";
    var LineCounter = class {
      constructor() {
        this.lineStarts = [];
        this.addNewLine = (offset) => this.lineStarts.push(offset);
        this.linePos = (offset) => {
          let low = 0;
          let high = this.lineStarts.length;
          while (low < high) {
            const mid = low + high >> 1;
            if (this.lineStarts[mid] < offset)
              low = mid + 1;
            else
              high = mid;
          }
          if (this.lineStarts[low] === offset)
            return { line: low + 1, col: 1 };
          if (low === 0)
            return { line: 0, col: offset };
          const start = this.lineStarts[low - 1];
          return { line: low, col: offset - start + 1 };
        };
      }
    };
    exports.LineCounter = LineCounter;
  }
});

// node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS({
  "node_modules/yaml/dist/parse/parser.js"(exports) {
    "use strict";
    var node_process = __require("node:process");
    var cst = require_cst();
    var lexer = require_lexer();
    function includesToken(list, type) {
      for (let i = 0; i < list.length; ++i)
        if (list[i].type === type)
          return true;
      return false;
    }
    function findNonEmptyIndex(list) {
      for (let i = 0; i < list.length; ++i) {
        switch (list[i].type) {
          case "space":
          case "comment":
          case "newline":
            break;
          default:
            return i;
        }
      }
      return -1;
    }
    function isFlowToken(token3) {
      switch (token3?.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "flow-collection":
          return true;
        default:
          return false;
      }
    }
    function getPrevProps(parent) {
      switch (parent.type) {
        case "document":
          return parent.start;
        case "block-map": {
          const it = parent.items[parent.items.length - 1];
          return it.sep ?? it.start;
        }
        case "block-seq":
          return parent.items[parent.items.length - 1].start;
        /* istanbul ignore next should not happen */
        default:
          return [];
      }
    }
    function getFirstKeyStartProps(prev) {
      if (prev.length === 0)
        return [];
      let i = prev.length;
      loop: while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
      while (prev[++i]?.type === "space") {
      }
      return prev.splice(i, prev.length);
    }
    function arrayPushArray(target, source) {
      if (source.length < 1e5)
        Array.prototype.push.apply(target, source);
      else
        for (let i = 0; i < source.length; ++i)
          target.push(source[i]);
    }
    function fixFlowSeqItems(fc) {
      if (fc.start.type === "flow-seq-start") {
        for (const it of fc.items) {
          if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
            if (it.key)
              it.value = it.key;
            delete it.key;
            if (isFlowToken(it.value)) {
              if (it.value.end)
                arrayPushArray(it.value.end, it.sep);
              else
                it.value.end = it.sep;
            } else
              arrayPushArray(it.start, it.sep);
            delete it.sep;
          }
        }
      }
    }
    var Parser = class {
      /**
       * @param onNewLine - If defined, called separately with the start position of
       *   each new line (in `parse()`, including the start of input).
       */
      constructor(onNewLine) {
        this.atNewLine = true;
        this.atScalar = false;
        this.indent = 0;
        this.offset = 0;
        this.onKeyLine = false;
        this.stack = [];
        this.source = "";
        this.type = "";
        this.lexer = new lexer.Lexer();
        this.onNewLine = onNewLine;
      }
      /**
       * Parse `source` as a YAML stream.
       * If `incomplete`, a part of the last line may be left as a buffer for the next call.
       *
       * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
       *
       * @returns A generator of tokens representing each directive, document, and other structure.
       */
      *parse(source, incomplete = false) {
        if (this.onNewLine && this.offset === 0)
          this.onNewLine(0);
        for (const lexeme of this.lexer.lex(source, incomplete))
          yield* this.next(lexeme);
        if (!incomplete)
          yield* this.end();
      }
      /**
       * Advance the parser by the `source` of one lexical token.
       */
      *next(source) {
        this.source = source;
        if (node_process.env.LOG_TOKENS)
          console.log("|", cst.prettyToken(source));
        if (this.atScalar) {
          this.atScalar = false;
          yield* this.step();
          this.offset += source.length;
          return;
        }
        const type = cst.tokenType(source);
        if (!type) {
          const message = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message, source });
          this.offset += source.length;
        } else if (type === "scalar") {
          this.atNewLine = false;
          this.atScalar = true;
          this.type = "scalar";
        } else {
          this.type = type;
          yield* this.step();
          switch (type) {
            case "newline":
              this.atNewLine = true;
              this.indent = 0;
              if (this.onNewLine)
                this.onNewLine(this.offset + source.length);
              break;
            case "space":
              if (this.atNewLine && source[0] === " ")
                this.indent += source.length;
              break;
            case "explicit-key-ind":
            case "map-value-ind":
            case "seq-item-ind":
              if (this.atNewLine)
                this.indent += source.length;
              break;
            case "doc-mode":
            case "flow-error-end":
              return;
            default:
              this.atNewLine = false;
          }
          this.offset += source.length;
        }
      }
      /** Call at end of input to push out any remaining constructions */
      *end() {
        while (this.stack.length > 0)
          yield* this.pop();
      }
      get sourceToken() {
        const st = {
          type: this.type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
        return st;
      }
      *step() {
        const top = this.peek(1);
        if (this.type === "doc-end" && top?.type !== "doc-end") {
          while (this.stack.length > 0)
            yield* this.pop();
          this.stack.push({
            type: "doc-end",
            offset: this.offset,
            source: this.source
          });
          return;
        }
        if (!top)
          return yield* this.stream();
        switch (top.type) {
          case "document":
            return yield* this.document(top);
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return yield* this.scalar(top);
          case "block-scalar":
            return yield* this.blockScalar(top);
          case "block-map":
            return yield* this.blockMap(top);
          case "block-seq":
            return yield* this.blockSequence(top);
          case "flow-collection":
            return yield* this.flowCollection(top);
          case "doc-end":
            return yield* this.documentEnd(top);
        }
        yield* this.pop();
      }
      peek(n) {
        return this.stack[this.stack.length - n];
      }
      *pop(error) {
        const token3 = error ?? this.stack.pop();
        if (!token3) {
          const message = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message };
        } else if (this.stack.length === 0) {
          yield token3;
        } else {
          const top = this.peek(1);
          if (token3.type === "block-scalar") {
            token3.indent = "indent" in top ? top.indent : 0;
          } else if (token3.type === "flow-collection" && top.type === "document") {
            token3.indent = 0;
          }
          if (token3.type === "flow-collection")
            fixFlowSeqItems(token3);
          switch (top.type) {
            case "document":
              top.value = token3;
              break;
            case "block-scalar":
              top.props.push(token3);
              break;
            case "block-map": {
              const it = top.items[top.items.length - 1];
              if (it.value) {
                top.items.push({ start: [], key: token3, sep: [] });
                this.onKeyLine = true;
                return;
              } else if (it.sep) {
                it.value = token3;
              } else {
                Object.assign(it, { key: token3, sep: [] });
                this.onKeyLine = !it.explicitKey;
                return;
              }
              break;
            }
            case "block-seq": {
              const it = top.items[top.items.length - 1];
              if (it.value)
                top.items.push({ start: [], value: token3 });
              else
                it.value = token3;
              break;
            }
            case "flow-collection": {
              const it = top.items[top.items.length - 1];
              if (!it || it.value)
                top.items.push({ start: [], key: token3, sep: [] });
              else if (it.sep)
                it.value = token3;
              else
                Object.assign(it, { key: token3, sep: [] });
              return;
            }
            /* istanbul ignore next should not happen */
            default:
              yield* this.pop();
              yield* this.pop(token3);
          }
          if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token3.type === "block-map" || token3.type === "block-seq")) {
            const last = token3.items[token3.items.length - 1];
            if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token3.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token3.indent))) {
              if (top.type === "document")
                top.end = last.start;
              else
                top.items.push({ start: last.start });
              token3.items.splice(-1, 1);
            }
          }
        }
      }
      *stream() {
        switch (this.type) {
          case "directive-line":
            yield { type: "directive", offset: this.offset, source: this.source };
            return;
          case "byte-order-mark":
          case "space":
          case "comment":
          case "newline":
            yield this.sourceToken;
            return;
          case "doc-mode":
          case "doc-start": {
            const doc = {
              type: "document",
              offset: this.offset,
              start: []
            };
            if (this.type === "doc-start")
              doc.start.push(this.sourceToken);
            this.stack.push(doc);
            return;
          }
        }
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML stream`,
          source: this.source
        };
      }
      *document(doc) {
        if (doc.value)
          return yield* this.lineEnd(doc);
        switch (this.type) {
          case "doc-start": {
            if (findNonEmptyIndex(doc.start) !== -1) {
              yield* this.pop();
              yield* this.step();
            } else
              doc.start.push(this.sourceToken);
            return;
          }
          case "anchor":
          case "tag":
          case "space":
          case "comment":
          case "newline":
            doc.start.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(doc);
        if (bv)
          this.stack.push(bv);
        else {
          yield {
            type: "error",
            offset: this.offset,
            message: `Unexpected ${this.type} token in YAML document`,
            source: this.source
          };
        }
      }
      *scalar(scalar) {
        if (this.type === "map-value-ind") {
          const prev = getPrevProps(this.peek(2));
          const start = getFirstKeyStartProps(prev);
          let sep3;
          if (scalar.end) {
            sep3 = scalar.end;
            sep3.push(this.sourceToken);
            delete scalar.end;
          } else
            sep3 = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep: sep3 }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else
          yield* this.lineEnd(scalar);
      }
      *blockScalar(scalar) {
        switch (this.type) {
          case "space":
          case "comment":
          case "newline":
            scalar.props.push(this.sourceToken);
            return;
          case "scalar":
            scalar.source = this.source;
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) {
              let nl = this.source.indexOf("\n") + 1;
              while (nl !== 0) {
                this.onNewLine(this.offset + nl);
                nl = this.source.indexOf("\n", nl) + 1;
              }
            }
            yield* this.pop();
            break;
          /* istanbul ignore next should not happen */
          default:
            yield* this.pop();
            yield* this.step();
        }
      }
      *blockMap(map) {
        const it = map.items[map.items.length - 1];
        switch (this.type) {
          case "newline":
            this.onKeyLine = false;
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "space":
          case "comment":
            if (it.value) {
              map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              if (this.atIndentedComment(it.start, map.indent)) {
                const prev = map.items[map.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  map.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
        }
        if (this.indent >= map.indent) {
          const atMapIndent = !this.onKeyLine && this.indent === map.indent;
          const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
          let start = [];
          if (atNextItem && it.sep && !it.value) {
            const nl = [];
            for (let i = 0; i < it.sep.length; ++i) {
              const st = it.sep[i];
              switch (st.type) {
                case "newline":
                  nl.push(i);
                  break;
                case "space":
                  break;
                case "comment":
                  if (st.indent > map.indent)
                    nl.length = 0;
                  break;
                default:
                  nl.length = 0;
              }
            }
            if (nl.length >= 2)
              start = it.sep.splice(nl[1]);
          }
          switch (this.type) {
            case "anchor":
            case "tag":
              if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start });
                this.onKeyLine = true;
              } else if (it.sep) {
                it.sep.push(this.sourceToken);
              } else {
                it.start.push(this.sourceToken);
              }
              return;
            case "explicit-key-ind":
              if (!it.sep && !it.explicitKey) {
                it.start.push(this.sourceToken);
                it.explicitKey = true;
              } else if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start, explicitKey: true });
              } else {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [this.sourceToken], explicitKey: true }]
                });
              }
              this.onKeyLine = true;
              return;
            case "map-value-ind":
              if (it.explicitKey) {
                if (!it.sep) {
                  if (includesToken(it.start, "newline")) {
                    Object.assign(it, { key: null, sep: [this.sourceToken] });
                  } else {
                    const start2 = getFirstKeyStartProps(it.start);
                    this.stack.push({
                      type: "block-map",
                      offset: this.offset,
                      indent: this.indent,
                      items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                    });
                  }
                } else if (it.value) {
                  map.items.push({ start: [], key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start, key: null, sep: [this.sourceToken] }]
                  });
                } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                  const start2 = getFirstKeyStartProps(it.start);
                  const key = it.key;
                  const sep3 = it.sep;
                  sep3.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep: sep3 }]
                  });
                } else if (start.length > 0) {
                  it.sep = it.sep.concat(start, this.sourceToken);
                } else {
                  it.sep.push(this.sourceToken);
                }
              } else {
                if (!it.sep) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else if (it.value || atNextItem) {
                  map.items.push({ start, key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: [], key: null, sep: [this.sourceToken] }]
                  });
                } else {
                  it.sep.push(this.sourceToken);
                }
              }
              this.onKeyLine = true;
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (atNextItem || it.value) {
                map.items.push({ start, key: fs, sep: [] });
                this.onKeyLine = true;
              } else if (it.sep) {
                this.stack.push(fs);
              } else {
                Object.assign(it, { key: fs, sep: [] });
                this.onKeyLine = true;
              }
              return;
            }
            default: {
              const bv = this.startBlockValue(map);
              if (bv) {
                if (bv.type === "block-seq") {
                  if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                    yield* this.pop({
                      type: "error",
                      offset: this.offset,
                      message: "Unexpected block-seq-ind on same line with key",
                      source: this.source
                    });
                    return;
                  }
                } else if (atMapIndent) {
                  map.items.push({ start });
                }
                this.stack.push(bv);
                return;
              }
            }
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *blockSequence(seq) {
        const it = seq.items[seq.items.length - 1];
        switch (this.type) {
          case "newline":
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                seq.items.push({ start: [this.sourceToken] });
            } else
              it.start.push(this.sourceToken);
            return;
          case "space":
          case "comment":
            if (it.value)
              seq.items.push({ start: [this.sourceToken] });
            else {
              if (this.atIndentedComment(it.start, seq.indent)) {
                const prev = seq.items[seq.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  seq.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
          case "anchor":
          case "tag":
            if (it.value || this.indent <= seq.indent)
              break;
            it.start.push(this.sourceToken);
            return;
          case "seq-item-ind":
            if (this.indent !== seq.indent)
              break;
            if (it.value || includesToken(it.start, "seq-item-ind"))
              seq.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
        }
        if (this.indent > seq.indent) {
          const bv = this.startBlockValue(seq);
          if (bv) {
            this.stack.push(bv);
            return;
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *flowCollection(fc) {
        const it = fc.items[fc.items.length - 1];
        if (this.type === "flow-error-end") {
          let top;
          do {
            yield* this.pop();
            top = this.peek(1);
          } while (top?.type === "flow-collection");
        } else if (fc.end.length === 0) {
          switch (this.type) {
            case "comma":
            case "explicit-key-ind":
              if (!it || it.sep)
                fc.items.push({ start: [this.sourceToken] });
              else
                it.start.push(this.sourceToken);
              return;
            case "map-value-ind":
              if (!it || it.value)
                fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              return;
            case "space":
            case "comment":
            case "newline":
            case "anchor":
            case "tag":
              if (!it || it.value)
                fc.items.push({ start: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                it.start.push(this.sourceToken);
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (!it || it.value)
                fc.items.push({ start: [], key: fs, sep: [] });
              else if (it.sep)
                this.stack.push(fs);
              else
                Object.assign(it, { key: fs, sep: [] });
              return;
            }
            case "flow-map-end":
            case "flow-seq-end":
              fc.end.push(this.sourceToken);
              return;
          }
          const bv = this.startBlockValue(fc);
          if (bv)
            this.stack.push(bv);
          else {
            yield* this.pop();
            yield* this.step();
          }
        } else {
          const parent = this.peek(2);
          if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
            yield* this.pop();
            yield* this.step();
          } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            fixFlowSeqItems(fc);
            const sep3 = fc.end.splice(1, fc.end.length);
            sep3.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep: sep3 }]
            };
            this.onKeyLine = true;
            this.stack[this.stack.length - 1] = map;
          } else {
            yield* this.lineEnd(fc);
          }
        }
      }
      flowScalar(type) {
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        return {
          type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
      }
      startBlockValue(parent) {
        switch (this.type) {
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return this.flowScalar(this.type);
          case "block-scalar-header":
            return {
              type: "block-scalar",
              offset: this.offset,
              indent: this.indent,
              props: [this.sourceToken],
              source: ""
            };
          case "flow-map-start":
          case "flow-seq-start":
            return {
              type: "flow-collection",
              offset: this.offset,
              indent: this.indent,
              start: this.sourceToken,
              items: [],
              end: []
            };
          case "seq-item-ind":
            return {
              type: "block-seq",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken] }]
            };
          case "explicit-key-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            start.push(this.sourceToken);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, explicitKey: true }]
            };
          }
          case "map-value-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, key: null, sep: [this.sourceToken] }]
            };
          }
        }
        return null;
      }
      atIndentedComment(start, indent) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent)
          return false;
        return start.every((st) => st.type === "newline" || st.type === "space");
      }
      *documentEnd(docEnd) {
        if (this.type !== "doc-mode") {
          if (docEnd.end)
            docEnd.end.push(this.sourceToken);
          else
            docEnd.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
        }
      }
      *lineEnd(token3) {
        switch (this.type) {
          case "comma":
          case "doc-start":
          case "doc-end":
          case "flow-seq-end":
          case "flow-map-end":
          case "map-value-ind":
            yield* this.pop();
            yield* this.step();
            break;
          case "newline":
            this.onKeyLine = false;
          // fallthrough
          case "space":
          case "comment":
          default:
            if (token3.end)
              token3.end.push(this.sourceToken);
            else
              token3.end = [this.sourceToken];
            if (this.type === "newline")
              yield* this.pop();
        }
      }
    };
    exports.Parser = Parser;
  }
});

// node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS({
  "node_modules/yaml/dist/public-api.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var errors = require_errors();
    var log = require_log();
    var identity = require_identity();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    function parseOptions(options) {
      const prettyErrors = options.prettyErrors !== false;
      const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
      return { lineCounter: lineCounter$1, prettyErrors };
    }
    function parseAllDocuments(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      const docs = Array.from(composer$1.compose(parser$1.parse(source)));
      if (prettyErrors && lineCounter2)
        for (const doc of docs) {
          doc.errors.forEach(errors.prettifyError(source, lineCounter2));
          doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
        }
      if (docs.length > 0)
        return docs;
      return Object.assign([], { empty: true }, composer$1.streamInfo());
    }
    function parseDocument2(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      let doc = null;
      for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
        if (!doc)
          doc = _doc;
        else if (doc.options.logLevel !== "silent") {
          doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
          break;
        }
      }
      if (prettyErrors && lineCounter2) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
      return doc;
    }
    function parse3(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument2(src, options);
      if (!doc)
        return null;
      doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options));
    }
    function stringify(value, replacer, options) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === void 0 && replacer) {
        options = replacer;
      }
      if (typeof options === "string")
        options = options.length;
      if (typeof options === "number") {
        const indent = Math.round(options);
        options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
      }
      if (value === void 0) {
        const { keepUndefined } = options ?? replacer ?? {};
        if (!keepUndefined)
          return void 0;
      }
      if (identity.isDocument(value) && !_replacer)
        return value.toString(options);
      return new Document.Document(value, _replacer, options).toString(options);
    }
    exports.parse = parse3;
    exports.parseAllDocuments = parseAllDocuments;
    exports.parseDocument = parseDocument2;
    exports.stringify = stringify;
  }
});

// node_modules/yaml/dist/index.js
var require_dist = __commonJS({
  "node_modules/yaml/dist/index.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var Schema = require_Schema();
    var errors = require_errors();
    var Alias = require_Alias();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var cst = require_cst();
    var lexer = require_lexer();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    var publicApi = require_public_api();
    var visit2 = require_visit();
    exports.Composer = composer.Composer;
    exports.Document = Document.Document;
    exports.Schema = Schema.Schema;
    exports.YAMLError = errors.YAMLError;
    exports.YAMLParseError = errors.YAMLParseError;
    exports.YAMLWarning = errors.YAMLWarning;
    exports.Alias = Alias.Alias;
    exports.isAlias = identity.isAlias;
    exports.isCollection = identity.isCollection;
    exports.isDocument = identity.isDocument;
    exports.isMap = identity.isMap;
    exports.isNode = identity.isNode;
    exports.isPair = identity.isPair;
    exports.isScalar = identity.isScalar;
    exports.isSeq = identity.isSeq;
    exports.Pair = Pair.Pair;
    exports.Scalar = Scalar.Scalar;
    exports.YAMLMap = YAMLMap.YAMLMap;
    exports.YAMLSeq = YAMLSeq.YAMLSeq;
    exports.CST = cst;
    exports.Lexer = lexer.Lexer;
    exports.LineCounter = lineCounter.LineCounter;
    exports.Parser = parser.Parser;
    exports.parse = publicApi.parse;
    exports.parseAllDocuments = publicApi.parseAllDocuments;
    exports.parseDocument = publicApi.parseDocument;
    exports.stringify = publicApi.stringify;
    exports.visit = visit2.visit;
    exports.visitAsync = visit2.visitAsync;
  }
});

// src/mcp-server.ts
import { randomUUID as randomUUID5 } from "node:crypto";
import { readFile, stat as stat7 } from "node:fs/promises";
import { homedir as homedir4 } from "node:os";
import { delimiter as delimiter2, join as join12 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/core/errors.ts
var ALL_LARVA_ERROR_CODES = [
  "LARVA_BAD_INPUT",
  "LARVA_CONFIG_INVALID",
  "LARVA_MODEL_MAP_INVALID",
  "LARVA_MODEL_UNAVAILABLE",
  "LARVA_PERSONA_INVALID",
  "LARVA_PERSONA_NOT_FOUND",
  "LARVA_PERSONA_CONFLICT",
  "LARVA_STORE_WRITE_FAILED",
  "LARVA_NO_ACTIVE_PERSONA",
  "LARVA_TOOL_DENIED",
  "LARVA_SPAWN_NOT_ALLOWED",
  "LARVA_CONFIRMATION_UNAVAILABLE",
  "LARVA_SWITCH_CHAIN_LIMIT",
  "LARVA_ROUTE_UNCERTAIN",
  "LARVA_RESTORE_FAILED",
  "LARVA_CWD_REQUIRED",
  "LARVA_SESSION_INVALID",
  "LARVA_SESSION_NOT_FOUND",
  "LARVA_SESSION_BUSY",
  "LARVA_CHILD_START_FAILED",
  "LARVA_CHILD_PROTOCOL_FAILED",
  "LARVA_CHILD_CANCELLED",
  "LARVA_INTERNAL_ERROR",
  "LARVA_CLI_USAGE"
];
var LarvaError = class extends Error {
  code;
  details;
  exitCode;
  constructor(code, message, details, exitCode) {
    super(message);
    this.name = "LarvaError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode ?? (code === "LARVA_CLI_USAGE" ? 2 : 1);
  }
};
function toErrorEnvelope(err) {
  if (!(err instanceof LarvaError)) {
    return { ok: false, error: { code: "LARVA_INTERNAL_ERROR", message: "An internal error occurred." } };
  }
  const { code, message, details } = err;
  return { ok: false, error: { code, message, ...details === void 0 ? {} : { details } } };
}

// src/core/predicates.ts
var THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isValidPersonaId(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

// src/runtime/supervisor.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { addAbortListener } from "node:events";
import { constants as constants8 } from "node:fs";
import { lstat as lstat5, open as open6, realpath as realpath6, rm as rm4, stat as stat5 } from "node:fs/promises";
import { setTimeout as delay2 } from "node:timers/promises";
import { basename as basename9, dirname as dirname9, isAbsolute as isAbsolute4, join as join11, resolve as resolve6 } from "node:path";
import { fileURLToPath } from "node:url";

// src/core/config.ts
import { join } from "node:path";
var MAX_TIMEOUT_MS = 864e5;
var MIN_STALL_ALERT_MS = 6e4;
function invalid(field2) {
  throw new LarvaError("LARVA_CONFIG_INVALID", `Invalid ${field2} in config.json.`);
}
function object(value, field2, keys2) {
  if (!isRecord(value)) return invalid(field2);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype || Object.keys(value).some((key) => !keys2.includes(key))) return invalid(field2);
  return value;
}
function field(obj, key, fallback) {
  return Object.hasOwn(obj, key) ? obj[key] : fallback;
}
function isIntegerIn(value, min, max) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function integer(value, name, min, max) {
  return isIntegerIn(value, min, max) ? value : invalid(name);
}
function isStallAlert(value) {
  return value === 0 || isIntegerIn(value, MIN_STALL_ALERT_MS, MAX_TIMEOUT_MS);
}
function parseLarvaConfig(value) {
  const config = object(value, "root object", ["default_persona", "switch_mode", "confirm_timeout_ms", "subagent", "gc"]);
  const persona = field(config, "default_persona", null);
  if (persona !== null && !isValidPersonaId(persona)) {
    return invalid("default_persona");
  }
  const mode = field(config, "switch_mode", "confirm");
  if (mode !== "manual" && mode !== "confirm" && mode !== "auto" && mode !== "free") return invalid("switch_mode");
  const confirm = field(config, "confirm_timeout_ms", 9e5);
  if (confirm !== 0 && !isIntegerIn(confirm, 1e3, MAX_TIMEOUT_MS)) return invalid("confirm_timeout_ms");
  const subagent = object(field(config, "subagent", {}), "subagent", [
    "extension_sources",
    "root_session_spawn",
    "max_depth",
    "max_active_runs",
    "stall_alert_ms"
  ]);
  const sources = field(subagent, "extension_sources", []);
  if (!Array.isArray(sources)) return invalid("subagent.extension_sources");
  const uniqueSources = /* @__PURE__ */ new Set();
  for (const source of sources) {
    if (typeof source !== "string" || source === "" || source.includes("\0") || uniqueSources.has(source)) {
      return invalid("subagent.extension_sources");
    }
    uniqueSources.add(source);
  }
  const rootSpawn = field(subagent, "root_session_spawn", "persona");
  if (rootSpawn !== "persona" && rootSpawn !== "allow") return invalid("subagent.root_session_spawn");
  const stall = field(subagent, "stall_alert_ms", 6e5);
  if (!isStallAlert(stall)) return invalid("subagent.stall_alert_ms");
  const gc = object(field(config, "gc", {}), "gc", ["max_age_days", "max_bytes"]);
  return {
    default_persona: persona,
    switch_mode: mode,
    confirm_timeout_ms: confirm,
    subagent: {
      extension_sources: [...uniqueSources],
      root_session_spawn: rootSpawn,
      stall_alert_ms: stall,
      ...Object.hasOwn(subagent, "max_depth") ? { max_depth: integer(subagent.max_depth, "subagent.max_depth", 1, 100) } : {},
      ...Object.hasOwn(subagent, "max_active_runs") ? { max_active_runs: integer(subagent.max_active_runs, "subagent.max_active_runs", 1, 100) } : {}
    },
    gc: {
      max_age_days: integer(field(gc, "max_age_days", 30), "gc.max_age_days", 1, 3650),
      ...Object.hasOwn(gc, "max_bytes") ? { max_bytes: integer(gc.max_bytes, "gc.max_bytes", 1048576, Infinity) } : {}
    }
  };
}
async function loadLarvaConfig(home, readTextIfPresent) {
  let value;
  try {
    const text2 = await readTextIfPresent(join(home, "config.json"));
    value = text2 === void 0 ? {} : JSON.parse(text2);
  } catch {
    throw new LarvaError("LARVA_CONFIG_INVALID", "Could not read or parse config.json.");
  }
  return parseLarvaConfig(value);
}
function resolveWatchdogTimeouts(input, config) {
  const timeout = input.no_progress_timeout_ms === void 0 ? 36e5 : input.no_progress_timeout_ms;
  if (!isIntegerIn(timeout, 12e4, MAX_TIMEOUT_MS)) {
    throw new LarvaError("LARVA_BAD_INPUT", "Invalid no_progress_timeout_ms.");
  }
  const stall = input.stall_alert_ms;
  if (stall !== void 0 && (!isStallAlert(stall) || stall >= timeout)) {
    throw new LarvaError("LARVA_BAD_INPUT", "stall_alert_ms must be disabled or within range and below no_progress_timeout_ms.");
  }
  return {
    no_progress_timeout_ms: timeout,
    stall_alert_ms: stall ?? Math.min(config.stall_alert_ms, Math.floor(timeout / 2))
  };
}

// src/core/model-map.ts
import { basename, join as join2 } from "node:path";
function invalid2(field2) {
  throw new LarvaError("LARVA_MODEL_MAP_INVALID", `Invalid ${field2} in the model map.`);
}
function object2(value, field2, keys2) {
  if (!isRecord(value)) return invalid2(field2);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype || keys2 && Object.keys(value).some((key) => !keys2.includes(key))) return invalid2(field2);
  return value;
}
function token(value, field2, allowEmpty = false) {
  if (typeof value !== "string" || !allowEmpty && value === "" || /\s/.test(value)) return invalid2(field2);
  return value;
}
function isValidProfileName(profile) {
  return typeof profile === "string" && profile !== "" && profile !== "default" && !/[^a-z0-9-]/.test(profile);
}
function parseModelMapDoc(value) {
  const doc = object2(value, "root object", ["models", "prefix_rules"]);
  const result2 = {};
  if (Object.hasOwn(doc, "models")) {
    result2.models = Object.fromEntries(Object.entries(object2(doc.models, "models")).map(([key, entry]) => {
      token(key, "models key");
      const model = object2(entry, "models entry", ["provider", "model_id"]);
      const route = {
        provider: token(model.provider, "models provider"),
        model_id: token(model.model_id, "models model_id")
      };
      return [key, route];
    }));
  }
  if (Object.hasOwn(doc, "prefix_rules")) {
    if (!Array.isArray(doc.prefix_rules)) return invalid2("prefix_rules");
    const rules = [];
    const seen = /* @__PURE__ */ new Set();
    for (const entry of doc.prefix_rules) {
      const rule = object2(entry, "prefix rule", ["from_prefix", "to_provider", "to_model_id_prefix"]);
      const fromPrefix = token(rule.from_prefix, "from_prefix");
      if (seen.has(fromPrefix)) return invalid2("duplicate from_prefix");
      seen.add(fromPrefix);
      rules.push({
        from_prefix: fromPrefix,
        to_provider: token(rule.to_provider, "to_provider"),
        to_model_id_prefix: token(rule.to_model_id_prefix, "to_model_id_prefix", true)
      });
    }
    result2.prefix_rules = rules;
  }
  return result2;
}
async function loadModelMap(home, path, reader) {
  const filename = basename(path);
  const isDefault = filename === "model-map.json";
  const profile = /^model-map\.(.+)\.json$/.exec(filename)?.[1];
  if (path !== join2(home, filename) || !isDefault && !isValidProfileName(profile)) return invalid2("file path");
  let value;
  try {
    if (isDefault && !await reader.entryExists(path)) return void 0;
    const contained = await reader.resolveContainedPath(home, path);
    value = JSON.parse(await reader.readText(contained));
  } catch {
    throw new LarvaError("LARVA_MODEL_MAP_INVALID", "Could not resolve, read, or parse the model map.");
  }
  return parseModelMapDoc(value);
}
function resolveModelRoute(specModel, modelMap) {
  const models = modelMap?.models;
  if (models && Object.hasOwn(models, specModel)) return models[specModel];
  let best;
  for (const rule of modelMap?.prefix_rules ?? []) {
    if (specModel.startsWith(rule.from_prefix) && (!best || rule.from_prefix.length > best.from_prefix.length)) {
      best = rule;
    }
  }
  if (best) {
    const model_id = best.to_model_id_prefix + specModel.slice(best.from_prefix.length);
    if (model_id === "") return invalid2("resolved model_id");
    return { provider: best.to_provider, model_id };
  }
  const slash = specModel.indexOf("/");
  if (slash <= 0 || slash === specModel.length - 1 || /\s/.test(specModel)) {
    throw new LarvaError("LARVA_BAD_INPUT", "Expected a literal provider/model_id route.");
  }
  return { provider: specModel.slice(0, slash), model_id: specModel.slice(slash + 1) };
}

// src/core/paths.ts
import { homedir } from "node:os";
import { isAbsolute, join as join3, normalize, relative, resolve, sep } from "node:path";
function resolveLarvaHome(env = process.env) {
  const home = env.LARVA_HOME;
  if (home === void 0 || home === "") return join3(env.HOME || homedir(), ".larva");
  if (!isAbsolute(home) || home.includes("\0") || normalize(home) !== home) {
    throw new LarvaError("LARVA_CONFIG_INVALID", "LARVA_HOME must be a normalized absolute path.");
  }
  return home;
}
var BASE_PI_AGENT_DIR_ENV = "LARVA_PI_BASE_AGENT_DIR";
function resolveBasePiAgentDir(env, fallbackHome, baseCwd) {
  const home = env.HOME || fallbackHome || homedir();
  const configured = env[BASE_PI_AGENT_DIR_ENV] || env.PI_CODING_AGENT_DIR || "~/.pi/agent";
  const expanded = configured.startsWith("~/") ? join3(home, configured.slice(2)) : configured;
  return resolve(baseCwd ?? "", expanded);
}
function modelMapProfilePath(home, profile = "default") {
  if (profile === "" || /[^a-z0-9-]/.test(profile)) {
    throw new LarvaError("LARVA_MODEL_MAP_INVALID", "Invalid model-map profile name.");
  }
  return join3(home, profile === "default" ? "model-map.json" : `model-map.${profile}.json`);
}
function getLarvaHomePaths(home) {
  const state = join3(home, "state");
  return {
    home,
    personas: join3(home, "personas"),
    config: join3(home, "config.json"),
    model_map: modelMapProfilePath(home),
    state,
    sessions: join3(state, "sessions"),
    artifacts: join3(state, "artifacts"),
    capsules: join3(state, "capsules")
  };
}
function isLexicallyContained(root, candidate) {
  if (!isAbsolute(root) || !isAbsolute(candidate) || root.includes("\0") || candidate.includes("\0")) {
    return false;
  }
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function assertContainedRealpath(realRoot, realCandidate) {
  if (!isLexicallyContained(realRoot, realCandidate)) {
    throw new LarvaError("LARVA_SESSION_INVALID", "The resolved path is outside the permitted directory.");
  }
}
async function resolveContainedPath(root, candidate, realpath7) {
  if (!isLexicallyContained(root, candidate)) {
    throw new LarvaError("LARVA_SESSION_INVALID", "The path is outside the permitted directory.");
  }
  const [realRoot, realCandidate] = await Promise.all([realpath7(root), realpath7(candidate)]);
  assertContainedRealpath(realRoot, realCandidate);
  return realCandidate;
}
async function resolveExtensionSources(sources, context) {
  const paths = [];
  let realHome;
  for (const [index, source] of sources.entries()) {
    if (source === "" || source.includes("\0")) {
      throw new LarvaError("LARVA_CONFIG_INVALID", `Invalid extension_sources entry at index ${index}.`);
    }
    try {
      let realPath;
      if (source.startsWith("pi-agent:")) {
        const suffix = source.slice("pi-agent:".length);
        if (!suffix || isAbsolute(suffix)) throw new Error("Expected a relative path.");
        const candidate = resolve(context.piAgentDir, suffix);
        if (!isLexicallyContained(context.piAgentDir, candidate)) throw new Error("Expected a path inside the Pi agent directory.");
        realPath = await context.realpath(candidate);
      } else if (/^[a-z][a-z\d+.-]*:/i.test(source)) {
        if (!/^(?:builtin|npm|git):/.test(source)) {
          const url = new URL(source);
          if (!["http:", "https:", "file:"].includes(url.protocol)) throw new Error("Unsupported extension URL.");
        }
        paths.push(source);
        continue;
      } else {
        let path;
        if (source.startsWith("~/")) path = join3(context.userHome, source.slice(2));
        else if (isAbsolute(source)) path = source;
        else {
          realHome ??= await context.realpath(context.larvaHome);
          path = resolve(realHome, source);
        }
        realPath = await context.realpath(path);
      }
      await context.assertReadable(realPath);
      paths.push(realPath);
    } catch {
      throw new LarvaError("LARVA_CONFIG_INVALID", `Invalid or unreadable extension_sources entry at index ${index}.`);
    }
  }
  return paths;
}

// src/core/spawn-policy.ts
function evaluateEffectiveCanSpawn(context) {
  const { parent_persona_id: explicitParent, env, resolvePersona } = context;
  const descendant = context.surface === "pi" ? context.isLaunchedChild : context.depth >= 1;
  if (descendant) {
    const initial = env?.LARVA_PI_INITIAL_PERSONA_ID;
    if (!initial?.trim() || explicitParent !== void 0 && explicitParent !== initial) {
      throw new LarvaError("LARVA_SPAWN_NOT_ALLOWED", "Descendant spawn authority requires the launch-bound persona.");
    }
    const persona2 = resolvePersona(initial);
    if (!persona2) throw new LarvaError("LARVA_SPAWN_NOT_ALLOWED", "The launch-bound persona could not be resolved.");
    return persona2.can_spawn;
  }
  if (context.surface === "pi") {
    if (context.activePersona === null) return false;
    const capability = context.activePersona.can_spawn;
    return capability === false && context.rootSessionSpawn === "allow" ? true : capability;
  }
  const parent = explicitParent ?? (env?.LARVA_MCP_PARENT_PERSONA?.trim() || void 0);
  if (parent === void 0) return true;
  if (!parent.trim()) throw new LarvaError("LARVA_BAD_INPUT", "parent_persona_id must not be blank.");
  const persona = resolvePersona(parent);
  if (!persona) throw new LarvaError("LARVA_PERSONA_NOT_FOUND", "The MCP parent persona could not be resolved.");
  return persona.can_spawn;
}
function assertCanSpawnTarget(effectiveCanSpawn, targetPersonaId) {
  if (effectiveCanSpawn !== true && (effectiveCanSpawn === false || !effectiveCanSpawn.includes(targetPersonaId))) {
    throw new LarvaError("LARVA_SPAWN_NOT_ALLOWED", "The effective spawn policy does not allow this target persona.");
  }
}

// src/store/artifacts.ts
import { createHash, randomUUID } from "node:crypto";
import { constants as constants2 } from "node:fs";
import { chmod, open as open2, rename, unlink } from "node:fs/promises";
import { dirname as dirname2, join as join5, resolve as resolve2 } from "node:path";

// src/store/bounded-read.ts
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename as basename2, dirname, join as join4 } from "node:path";
function isErrno(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
async function entryExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}
async function canonicalPath(path) {
  if (await entryExists(path)) return realpath(path);
  const parent = dirname(path);
  if (parent === path) return realpath(path);
  return join4(await canonicalPath(parent), basename2(path));
}
async function requireRealDirectory(path, create = false) {
  if (create) {
    await mkdir(path, { mode: 448 }).catch((error) => {
      if (!isErrno(error, "EEXIST")) throw error;
    });
  }
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error(`Expected a real directory: ${path}`);
  return info;
}
async function requireStateDirectory(path, create = false) {
  const state = dirname(path);
  if (create) await mkdir(dirname(state), { recursive: true, mode: 448 });
  await requireRealDirectory(state, create);
  return requireRealDirectory(path, create);
}
var decoder = new TextDecoder("utf-8", { fatal: true });
async function readBoundedRegularBytes(path, { maxBytes, flags = 0 }) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | flags);
  try {
    const metadata = await file.stat({ bigint: true });
    if (!metadata.isFile() || metadata.size > maxBytes) throw new Error("Invalid regular file size or type.");
    const bytes = Buffer.allocUnsafe(Number(metadata.size) + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (bytesRead === 0) return { bytes: bytes.subarray(0, used), metadata };
      used += bytesRead;
    }
    throw new Error("File grew while being read.");
  } finally {
    await file.close();
  }
}
async function readBoundedRegularText(path, options) {
  const { bytes } = await readBoundedRegularBytes(path, options);
  return decoder.decode(bytes);
}

// src/store/artifacts.ts
var inlineCodePoints = 36e3;
var previewCodePoints = 2e3;
var maxSlicePoints = 4e3;
function sliceCollector({ offset = 0, length = maxSlicePoints }) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > maxSlicePoints) return;
  let skipped = 0;
  const points = [];
  let more = false;
  return {
    // Return true only on seeing a real lookahead code point.
    add(chunk) {
      for (const point of chunk) {
        if (skipped < offset) {
          skipped++;
          continue;
        }
        if (points.length === length) {
          more = true;
          return true;
        }
        points.push(point);
      }
      return false;
    },
    result() {
      return {
        state: "ok",
        text: points.join(""),
        offset,
        length: points.length,
        ...more ? { continuation_offset: offset + points.length } : {}
      };
    }
  };
}
function readRunTextSlice(text2, query) {
  const slice = sliceCollector(query);
  if (!slice) return { state: "unavailable" };
  slice.add(text2);
  return slice.result();
}
async function readArtifactSlice(home, path, query) {
  const slice = sliceCollector(query);
  if (!slice) return { state: "unavailable" };
  try {
    const directory2 = getLarvaHomePaths(await canonicalPath(home)).artifacts;
    if (dirname2(path) !== directory2 || resolve2(path) !== path || !path.endsWith(".txt") || path.includes("\0")) {
      return { state: "unavailable" };
    }
    await requireStateDirectory(directory2);
    const file = await open2(path, constants2.O_RDONLY | constants2.O_NONBLOCK | constants2.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) return { state: "unavailable" };
      const decoder5 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const buffer = Buffer.alloc(16384);
      for (let remaining = before.size; remaining > 0n; ) {
        const { bytesRead } = await file.read(buffer, 0, remaining < buffer.length ? Number(remaining) : buffer.length, null);
        if (bytesRead === 0) return { state: "unavailable" };
        remaining -= BigInt(bytesRead);
        if (slice.add(decoder5.decode(buffer.subarray(0, bytesRead), { stream: remaining > 0n }))) break;
      }
      const after = await file.stat({ bigint: true });
      if (before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs) return slice.result();
    } finally {
      await file.close();
    }
  } catch {
  }
  return { state: "unavailable" };
}
async function writeOutputSnapshot(home, text2) {
  let points = 0;
  let previewEnd = 0;
  for (const char of text2) {
    points++;
    if (points <= previewCodePoints) previewEnd += char.length;
    if (points > inlineCodePoints) break;
  }
  if (points <= inlineCodePoints) return { output_state: "inline", result_text: text2 };
  let staged;
  try {
    const bytes = Buffer.from(text2, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let lines = bytes[bytes.length - 1] === 10 ? 0 : 1;
    for (const byte of bytes) if (byte === 10) lines++;
    const directory2 = getLarvaHomePaths(await canonicalPath(home)).artifacts;
    const metadata = await requireStateDirectory(directory2, true);
    if ((metadata.mode & 4095) !== 448) await chmod(directory2, 448);
    const name = randomUUID();
    const path = join5(directory2, `${name}.txt`);
    const temporary = join5(directory2, `.artifact.tmp.${process.pid}.${name}`);
    const file = await open2(temporary, "wx", 384);
    staged = temporary;
    try {
      await file.chmod(384);
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    return {
      output_state: "artifactized",
      result_preview: text2.slice(0, previewEnd),
      full_output_artifact: { path, bytes: bytes.length, sha256, lines }
    };
  } catch {
    if (staged !== void 0) await unlink(staged).catch(() => void 0);
    return {
      output_state: "delivery_failed",
      output_diagnostic: { code: "LARVA_STORE_WRITE_FAILED", message: "Could not persist full output artifact." }
    };
  }
}

// src/store/capsule.ts
var capsule_exports = {};
__export(capsule_exports, {
  capsuleParentPid: () => capsuleParentPid,
  createCapsule: () => createCapsule,
  inspectCapsule: () => inspectCapsule,
  inspectDescendantPids: () => inspectDescendantPids,
  isErrno: () => isErrno,
  isPid: () => isPid,
  linkedCapsuleRoots: () => linkedCapsuleRoots,
  pidExited: () => pidExited,
  privateDirectory: () => privateDirectory,
  readMetadata: () => readMetadata,
  writeMetadata: () => writeMetadata
});
import { randomBytes } from "node:crypto";
import { constants as constants3 } from "node:fs";
import { access, lstat as lstat2, mkdir as mkdir2, open as open3, opendir, realpath as realpath2, rename as rename2, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { basename as basename3, dirname as dirname3, join as join6 } from "node:path";
var { O_NOFOLLOW, R_OK, X_OK } = constants3;
var CAPSULE_NAME = /^child-([1-9][0-9]*)-[a-f0-9]+$/;
var MAX_TREE_DEPTH = 100;
var MAX_CENSUS_ENTRIES = 1e4;
function isPid(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647;
}
function pidExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isErrno(error, "ESRCH");
  }
}
async function privateDirectory(path) {
  try {
    const entry = await requireStateDirectory(path, true);
    if ((entry.mode & 63) === 0) return;
  } catch {
    throw new LarvaError("LARVA_STORE_WRITE_FAILED", `Cannot prepare private state directory: ${path}`);
  }
  throw new LarvaError("LARVA_STORE_WRITE_FAILED", `Expected a private state directory: ${path}`);
}
async function readMetadata(path) {
  return JSON.parse(await readBoundedRegularText(path, { maxBytes: 65536, flags: O_NOFOLLOW }));
}
async function writeMetadata(path, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 65536) throw new LarvaError("LARVA_STORE_WRITE_FAILED", "Metadata exceeds the write limit.");
  const temp = `${path}.tmp.${process.pid}.${randomBytes(16).toString("hex")}`;
  const file = await open3(temp, "wx", 384);
  try {
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    await rename2(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {
    });
    throw error;
  }
}
var missingBase = (error) => isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR");
async function snapshotPiConfig(agentDir, name) {
  const path = join6(agentDir, name);
  try {
    const entry = await lstat2(path).catch((error) => {
      if (!missingBase(error)) throw error;
    });
    if (!entry) return void 0;
    return (await readBoundedRegularBytes(await realpath2(path), { maxBytes: 1048576, flags: O_NOFOLLOW })).bytes;
  } catch {
    throw new LarvaError("LARVA_CONFIG_INVALID", `Pi ${name} must be a readable regular file of at most 1 MiB.`);
  }
}
var privatePiEntries = /* @__PURE__ */ new Set(["settings.json", "models.json", "sessions", "backups", "crashes.json"]);
async function projectPiResources(base, agentDir) {
  const entries = await opendir(base).catch((error) => {
    if (!missingBase(error)) throw error;
  });
  if (!entries) return;
  for await (const { name } of entries) {
    if (privatePiEntries.has(name) || name.endsWith("-debug.log") || name.endsWith(".lock")) continue;
    let target, info;
    try {
      target = await realpath2(join6(base, name));
      info = await stat(target);
    } catch (error) {
      if (missingBase(error) || isErrno(error, "ELOOP")) continue;
      throw error;
    }
    if (info.isFile() || info.isDirectory()) await symlink(target, join6(agentDir, name), info.isDirectory() ? "dir" : "file");
  }
}
async function createCapsule(options) {
  const home = await canonicalPath(options.home);
  const capsules = getLarvaHomePaths(home).capsules;
  const root = join6(capsules, `child-${process.pid}-${randomBytes(16).toString("hex")}`);
  await privateDirectory(capsules);
  const [extension_sources, settings, models] = await Promise.all([
    resolveExtensionSources(options.extension_sources, {
      larvaHome: home,
      userHome: options.user_home ?? homedir2(),
      piAgentDir: options.pi_agent_dir,
      realpath: realpath2,
      async assertReadable(path) {
        const entry = await stat(path);
        if (!entry.isDirectory() && !entry.isFile()) throw new Error("Expected file or directory.");
        await access(path, entry.isDirectory() ? R_OK | X_OK : R_OK);
      }
    }),
    snapshotPiConfig(options.pi_agent_dir, "settings.json"),
    snapshotPiConfig(options.pi_agent_dir, "models.json")
  ]);
  const agent_dir = join6(root, "agent");
  const settings_path = join6(agent_dir, "settings.json");
  const models_path = models === void 0 ? void 0 : join6(agent_dir, "models.json");
  const staged = join6(capsules, `.${basename3(root)}.tmp`);
  const stagedAgent = join6(staged, "agent");
  await mkdir2(staged, { mode: 448 });
  try {
    await mkdir2(join6(staged, "descendants"), { mode: 448 });
    await mkdir2(stagedAgent, { mode: 448 });
    await writeFile(join6(stagedAgent, "settings.json"), settings ?? "{}\n", { mode: 384, flag: "wx" });
    if (models !== void 0) await writeFile(join6(stagedAgent, "models.json"), models, { mode: 384, flag: "wx" });
    await projectPiResources(options.pi_agent_dir, stagedAgent);
    await writeMetadata(join6(staged, "owner.json"), { owner_pid: process.pid, state: "reserving" });
    await rename2(staged, root);
    return { root, agent_dir, settings_path, models_path, extension_sources };
  } catch (error) {
    await rm(staged, { recursive: true, force: true }).catch(() => {
    });
    throw error;
  }
}
function capsuleParentPid(home, root) {
  if (dirname3(root) !== getLarvaHomePaths(home).capsules) return void 0;
  const match = CAPSULE_NAME.exec(basename3(root));
  if (!match || join6(dirname3(root), match[0]) !== root) return void 0;
  const pid = Number(match[1]);
  return isPid(pid) ? pid : void 0;
}
function parseOwner(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => !["owner_pid", "state", "child_pid"].includes(key))) {
    throw new Error("Invalid capsule owner metadata.");
  }
  const { owner_pid, state, child_pid } = value;
  if (!isPid(owner_pid) || state !== "reserving" && state !== "spawning" && state !== "running" && state !== "unreconciled" || child_pid !== void 0 && child_pid !== null && !isPid(child_pid) || state === "running" && !isPid(child_pid) || (state === "reserving" || state === "spawning") && isPid(child_pid)) {
    throw new Error("Invalid capsule owner metadata.");
  }
  return { owner_pid, state, child_pid };
}
async function* readDescendants(home, dir, names) {
  for (const name of names) {
    const record2 = await readMetadata(join6(dir, name)).catch(() => void 0);
    if (!isRecord(record2)) {
      yield void 0;
      continue;
    }
    const { pid, capsule_root: root } = record2;
    const owner = typeof root === "string" ? capsuleParentPid(home, root) : void 0;
    if (pid !== void 0 && !isPid(pid) || pid === void 0 && owner === void 0) {
      yield void 0;
      continue;
    }
    yield typeof root === "string" && owner !== void 0 ? { pid, linked: { root, owner } } : root === void 0 ? { pid } : void 0;
  }
}
function descendantCensus() {
  let remaining = MAX_CENSUS_ENTRIES;
  return async (dir) => {
    const names = [];
    for await (const entry of await opendir(dir)) {
      if (--remaining < 0) throw new Error("Capsule proof exceeds the census limit.");
      if (entry.name.endsWith(".json")) names.push(entry.name);
    }
    return names.sort();
  };
}
async function linkedCapsuleRoots(home, root) {
  const dir = join6(root, "descendants");
  const links = /* @__PURE__ */ new Set();
  const canonicalHome = await canonicalPath(home);
  if (capsuleParentPid(canonicalHome, root) === void 0) throw new Error("Invalid capsule path.");
  await requireStateDirectory(dirname3(root));
  if (!(await lstat2(root)).isDirectory() || !(await lstat2(dir)).isDirectory()) throw new Error("Invalid capsule descendant directory.");
  for await (const record2 of readDescendants(canonicalHome, dir, await descendantCensus()(dir))) {
    if (!record2) throw new Error("Invalid capsule descendant record.");
    if (record2.linked) links.add(record2.linked.root);
  }
  return links;
}
async function readCapsulePids(root, owner, expectedPid) {
  const pids = /* @__PURE__ */ new Set();
  if (expectedPid != null) pids.add(expectedPid);
  if (owner.child_pid != null) pids.add(owner.child_pid);
  try {
    const self = await readMetadata(join6(root, "child_self.json"));
    if (!isRecord(self) || !isPid(self.pid)) throw new Error("Invalid capsule PID record.");
    pids.add(self.pid);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  return pids;
}
async function inspectDescendantPids(home, root) {
  const seen = /* @__PURE__ */ new Set();
  const pids = /* @__PURE__ */ new Set();
  const records = descendantCensus();
  let complete = true;
  async function visit2(canonicalHome, path, ownerPid, depth) {
    if (depth > MAX_TREE_DEPTH || seen.has(path) || !(await lstat2(path)).isDirectory()) throw new Error("Invalid capsule tree.");
    seen.add(path);
    try {
      const owner = parseOwner(await readMetadata(join6(path, "owner.json")));
      if (owner.owner_pid !== ownerPid) throw new Error("Capsule owner does not match its path.");
      if (owner.child_pid != null) pids.add(owner.child_pid);
      const children = await readCapsulePids(path, owner);
      for (const pid of children) pids.add(pid);
      if ((owner.state === "spawning" || owner.state === "unreconciled") && children.size === 0) complete = false;
    } catch {
      complete = false;
    }
    const dir = join6(path, "descendants");
    if (!(await lstat2(dir)).isDirectory()) throw new Error("Invalid descendant directory.");
    for await (const record2 of readDescendants(canonicalHome, dir, await records(dir))) {
      if (!record2) {
        complete = false;
        continue;
      }
      if (record2.pid !== void 0) pids.add(record2.pid);
      if (record2.linked) {
        const { root: root2, owner } = record2.linked;
        try {
          await visit2(canonicalHome, root2, owner, depth + 1);
        } catch (error) {
          if (!(record2.pid !== void 0 && isErrno(error, "ENOENT") && pidExited(record2.pid) && pidExited(owner))) complete = false;
        }
      }
    }
  }
  try {
    const canonicalHome = await canonicalPath(home);
    const owner = capsuleParentPid(canonicalHome, root);
    if (owner === void 0) throw new Error("Invalid capsule path.");
    await requireStateDirectory(dirname3(root));
    await visit2(canonicalHome, root, owner, 0);
  } catch {
    complete = false;
  }
  return { pids: [...pids], complete };
}
async function inspectCapsule(home, root, leaseChildPid, ownerMode = "exited") {
  const seen = /* @__PURE__ */ new Set();
  const records = descendantCensus();
  async function inspect(canonicalHome, root2, ppid, expectedPid, depth) {
    if (depth > MAX_TREE_DEPTH || seen.has(root2) || !(await lstat2(root2)).isDirectory()) {
      throw new Error("Invalid capsule tree.");
    }
    seen.add(root2);
    const ownedHere = depth === 0 && ownerMode === "live";
    const ownerSettled = ownedHere ? ppid === process.pid : pidExited(ppid);
    const owner = parseOwner(await readMetadata(join6(root2, "owner.json")));
    if (owner.owner_pid !== ppid) throw new Error("Capsule owner does not match its path.");
    const childPids = await readCapsulePids(root2, owner, expectedPid);
    const proof = { all_exited: false, has_child: childPids.size > 0, state: owner.state };
    if (!ownerSettled || ownedHere && expectedPid != null && childPids.size !== 1) return proof;
    if (![...childPids].every(pidExited)) return proof;
    const descendants = join6(root2, "descendants");
    const before = await lstat2(descendants, { bigint: true });
    if (!before.isDirectory()) throw new Error("Invalid descendant directory.");
    const names = await records(descendants);
    for await (const record2 of readDescendants(canonicalHome, descendants, names)) {
      if (!record2) throw new Error("Invalid descendant record.");
      const { pid, linked } = record2;
      if (pid !== void 0 && !pidExited(pid)) return proof;
      if (!linked) continue;
      if (seen.has(linked.root)) return proof;
      try {
        await lstat2(linked.root);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
        if (pid === void 0 || !pidExited(linked.owner)) return proof;
        continue;
      }
      const nested = await inspect(canonicalHome, linked.root, linked.owner, pid ?? null, depth + 1);
      if (!nested.all_exited || !nested.has_child && pid === void 0) return proof;
    }
    const finalNames = await records(descendants);
    const after = await lstat2(descendants, { bigint: true });
    proof.all_exited = before.dev === after.dev && before.ino === after.ino && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && finalNames.length === names.length && finalNames.every((name, index) => name === names[index]);
    return proof;
  }
  try {
    const canonicalHome = await canonicalPath(home);
    const ppid = capsuleParentPid(canonicalHome, root);
    if (ppid !== void 0) {
      await requireStateDirectory(dirname3(root));
      return await inspect(canonicalHome, root, ppid, leaseChildPid, 0);
    }
  } catch {
  }
  return void 0;
}

// src/store/model-map.ts
import { constants as constants4 } from "node:fs";
import { realpath as realpath3 } from "node:fs/promises";
function readBoundedRegularText2(path, flags = 0) {
  return readBoundedRegularText(path, { maxBytes: 1048576, flags });
}
function diskModelMapReader(home) {
  return {
    entryExists,
    resolveContainedPath: (_root, path) => resolveContainedPath(home, path, realpath3),
    // The selected entry can be a symlink; open its resolved target instead.
    readText: (path) => readBoundedRegularText2(path, constants4.O_NOFOLLOW)
  };
}
function loadDiskModelMap(home, path) {
  return loadModelMap(home, path, diskModelMapReader(home));
}

// src/store/persona-store.ts
import { createHash as createHash4, randomUUID as randomUUID2 } from "node:crypto";
import { constants as constants6 } from "node:fs";
import { mkdir as mkdir4, open as open5, readdir as readdir2, rename as rename4, rm as rm3, stat as stat3, unlink as unlink2 } from "node:fs/promises";
import { basename as basename7, dirname as dirname6, extname as extname2, join as join9 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// src/core/persona.ts
import { basename as basename4, extname } from "node:path";

// src/core/digest.ts
import { createHash as createHash2 } from "node:crypto";
function canonicalizePersona(fields) {
  const { id, description, prompt, model, thinking = "medium", can_spawn = false, tools } = fields;
  const canonical = {
    can_spawn: Array.isArray(can_spawn) ? [...can_spawn].sort() : can_spawn,
    description,
    id,
    model,
    prompt,
    thinking,
    tools: { allow: [...tools?.allow ?? []].sort(), deny: [...tools?.deny ?? []].sort() }
  };
  const hex = createHash2("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  return { ...canonical, spec_digest: `sha256:${hex}` };
}

// src/core/yaml-frontmatter.ts
var import_yaml = __toESM(require_dist(), 1);
var nonPrintable = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x84\x86-\x9f\ufffe\uffff]/gu;
var coreTags = new Set(["str", "int", "float", "bool", "null", "map", "seq"].map((tag) => `tag:yaml.org,2002:${tag}`));
function invalid3(message) {
  throw new LarvaError("LARVA_PERSONA_INVALID", `Invalid YAML frontmatter: ${message}`);
}
function parseYamlFrontmatter(text2) {
  const normalized = text2.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) invalid3("expected an opening '---' line");
  const closing = /\n---(?:\n|$)/g;
  closing.lastIndex = 3;
  const match = closing.exec(normalized);
  if (!match) invalid3("expected a closing '---' line");
  const header = normalized.slice(4, match.index + 1);
  if (header.search(nonPrintable) !== -1) invalid3("unexpected control character");
  const doc = (0, import_yaml.parseDocument)(header, { version: "1.2", schema: "core", merge: false, uniqueKeys: true });
  const diagnostic = doc.errors[0] ?? doc.warnings[0];
  if (diagnostic) invalid3(`invalid YAML syntax or feature (${diagnostic.code})`);
  if (doc.directives?.docStart || doc.directives?.docEnd) invalid3("directives and document markers are not supported");
  if (!(0, import_yaml.isMap)(doc.contents)) invalid3("expected a map");
  (0, import_yaml.visit)(doc, {
    Alias: () => invalid3("aliases are not supported"),
    Node(_key, node, path) {
      if (node.anchor) invalid3("anchors are not supported");
      if (node.tag !== void 0 && !coreTags.has(node.tag)) invalid3("only YAML Core tags are supported");
      if (path.filter(import_yaml.isCollection).length > 64) invalid3("collections are nested too deeply");
      if ((0, import_yaml.isScalar)(node) && typeof node.value === "number" && !Number.isFinite(node.value)) {
        invalid3("non-finite numbers are not supported");
      }
    },
    Pair(_key, pair) {
      if (!(0, import_yaml.isScalar)(pair.key) || typeof pair.key.value !== "string") invalid3("map keys must be strings");
      if (pair.key.value === "<<") invalid3("merge keys are not supported");
    }
  });
  return { fields: doc.toJS(), body: normalized.slice(closing.lastIndex) };
}

// src/core/persona.ts
var markdownFields = ["id", "description", "model", "thinking", "can_spawn", "tools"];
var jsonFields = [...markdownFields, "prompt", "spec_digest"];
var modelRoute = /^[^\s/]+\/[^\s]+$/;
var toolPattern = /^[^\s*]+\*?$/;
function invalid4(message) {
  throw new LarvaError("LARVA_PERSONA_INVALID", message);
}
function closedObject(value, label, allowed) {
  if (!isRecord(value)) invalid4(`${label} must be an object.`);
  const fields = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.includes(key)) invalid4(`Unexpected ${label} field: ${JSON.stringify(key)}.`);
    fields[key] = item;
  }
  return fields;
}
function isWellFormedString(value) {
  return typeof value === "string" && value.isWellFormed();
}
function normalizeText(value, field2) {
  if (!isWellFormedString(value)) invalid4(`${field2} must be a non-empty, well-formed string.`);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) invalid4(`${field2} must be a non-empty string.`);
  return normalized;
}
function uniqueStrings(value, field2, matches2) {
  if (!Array.isArray(value)) invalid4(`${field2} must be an array.`);
  const entries = /* @__PURE__ */ new Set();
  for (const entry of value) {
    if (!isWellFormedString(entry) || !matches2(entry)) invalid4(`${field2} contains an invalid entry.`);
    if (entries.has(entry)) invalid4(`${field2} contains a duplicate entry.`);
    entries.add(entry);
  }
  return [...entries];
}
function parseJson(text2) {
  try {
    return JSON.parse(text2);
  } catch {
    invalid4("Invalid JSON persona input.");
  }
}
function parse(text2, format, stem) {
  const md = format === "md" ? parseYamlFrontmatter(text2) : void 0;
  const fields = md ? closedObject(md.fields, "frontmatter", markdownFields) : closedObject(parseJson(text2), "persona", jsonFields);
  const { description, model, thinking, can_spawn, tools, spec_digest } = fields;
  const id = md && !Object.hasOwn(fields, "id") ? stem : fields.id;
  if (!isValidPersonaId(id)) invalid4("id must be a lowercase kebab-case identifier.");
  if (stem !== void 0 && id !== stem) invalid4("Persona id must match the filename stem.");
  if (!isWellFormedString(model) || !modelRoute.test(model)) invalid4("model must be a whitespace-free provider/model_id route.");
  const level = THINKING_LEVELS.find((candidate) => candidate === thinking);
  if (thinking !== void 0 && level === void 0) invalid4("Invalid thinking level.");
  let spawn2;
  if (can_spawn === void 0 || typeof can_spawn === "boolean") spawn2 = can_spawn;
  else {
    if (!Array.isArray(can_spawn) || can_spawn.length < 1 || can_spawn.length > 100) {
      invalid4("can_spawn must be a boolean or an array of 1 to 100 persona IDs.");
    }
    spawn2 = uniqueStrings(can_spawn, "can_spawn", isValidPersonaId);
  }
  const policy = tools === void 0 ? void 0 : closedObject(tools, "tools", ["allow", "deny"]);
  const patterns = (key) => policy && Object.hasOwn(policy, key) ? uniqueStrings(policy[key], `tools.${key}`, (entry) => toolPattern.test(entry)) : void 0;
  const spec = canonicalizePersona({
    id,
    model,
    thinking: level,
    can_spawn: spawn2,
    description: normalizeText(description, "description"),
    prompt: normalizeText(md ? md.body : fields.prompt, "prompt"),
    tools: { allow: patterns("allow"), deny: patterns("deny") }
  });
  if (Object.hasOwn(fields, "spec_digest") && spec_digest !== spec.spec_digest) {
    invalid4("spec_digest does not match the computed persona digest.");
  }
  return spec;
}
function parsePersonaFile(text2, filePath) {
  const extension = extname(filePath);
  if (extension !== ".md" && extension !== ".json") invalid4("Expected a .md or .json persona filename.");
  const stem = basename4(filePath, extension);
  if (!isValidPersonaId(stem)) invalid4("Persona filename stem must be a lowercase kebab-case identifier.");
  return parse(text2, extension === ".md" ? "md" : "json", stem);
}
function parsePersonaInput(text2, source = "-") {
  if (source !== "-") return parsePersonaFile(text2, source);
  return parse(text2, text2.trimStart().startsWith("{") ? "json" : "md");
}
function toPersonaSummary(spec) {
  const { id, description, model, thinking, can_spawn, spec_digest } = spec;
  return { id, description, model, thinking, can_spawn, spec_digest };
}

// src/store/session-lease.ts
import { createHash as createHash3, randomBytes as randomBytes2 } from "node:crypto";
import { link, lstat as lstat4, mkdir as mkdir3, rename as rename3, rm as rm2 } from "node:fs/promises";
import { basename as basename6, dirname as dirname5, join as join8, resolve as resolve4 } from "node:path";

// src/store/session-index.ts
import { constants as constants5 } from "node:fs";
import { lstat as lstat3, open as open4, readdir, realpath as realpath4, stat as stat2 } from "node:fs/promises";
import { basename as basename5, dirname as dirname4, isAbsolute as isAbsolute2, join as join7, resolve as resolve3 } from "node:path";
var MAX_SESSION_NAME_BYTES = 255 - ".lock.retired.".length - 10 - 1 - 32;
var HEADER_LIMIT = 1048576;
function invalid5() {
  return new LarvaError("LARVA_SESSION_INVALID", "Invalid Pi session header or transcript path.");
}
function parseHeader(bytes, task_id) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid5();
  }
  if (value === null || typeof value !== "object" || !("type" in value) || value.type !== "session" || !("version" in value) || !("cwd" in value)) throw invalid5();
  const { version, cwd } = value;
  if (version !== 2 && version !== 3 || typeof cwd !== "string" || !isAbsolute2(cwd) || cwd.includes("\0")) {
    throw invalid5();
  }
  return { task_id, version, cwd };
}
function sessionReadError(error) {
  if (isErrno(error, "ENOENT")) {
    return new LarvaError("LARVA_SESSION_NOT_FOUND", "Session transcript is missing.");
  }
  return error instanceof LarvaError ? error : invalid5();
}
async function resolveCanonicalSessionPath(home, taskId2) {
  if (taskId2.includes("\0") || !isAbsolute2(taskId2) || resolve3(taskId2) !== taskId2 || !taskId2.endsWith(".jsonl")) throw invalid5();
  try {
    const root = getLarvaHomePaths(await canonicalPath(home)).sessions;
    if (!isLexicallyContained(root, taskId2) || dirname4(taskId2) !== root || Buffer.byteLength(basename5(taskId2)) > MAX_SESSION_NAME_BYTES) throw invalid5();
    await requireStateDirectory(root).catch((error) => {
      throw sessionReadError(error);
    });
    const info = await lstat3(taskId2).catch((error) => {
      throw sessionReadError(error);
    });
    if (!info.isFile() || await realpath4(taskId2) !== taskId2) throw invalid5();
    return taskId2;
  } catch (error) {
    throw error instanceof LarvaError ? error : invalid5();
  }
}
async function readSessionHeader(home, taskId2) {
  const task_id = await resolveCanonicalSessionPath(home, taskId2);
  try {
    const file = await open4(task_id, constants5.O_RDONLY | constants5.O_NONBLOCK | constants5.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw invalid5();
      const buffer = Buffer.alloc(HEADER_LIMIT + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await file.read(buffer, used, Math.min(8192, buffer.length - used), used);
        if (bytesRead === 0) return parseHeader(buffer.subarray(0, used), task_id);
        const newline = buffer.subarray(used, used + bytesRead).indexOf(10);
        if (newline !== -1) return parseHeader(buffer.subarray(0, used + newline), task_id);
        used += bytesRead;
      }
      throw invalid5();
    } finally {
      await file.close();
    }
  } catch (error) {
    throw sessionReadError(error);
  }
}
async function sessionCwdExists(cwd) {
  try {
    return (await stat2(cwd)).isDirectory();
  } catch {
    return false;
  }
}
async function readDiskSession(home, taskId2, leases) {
  const { task_id, cwd } = await readSessionHeader(home, taskId2);
  const [cwd_exists, lock_state] = await Promise.all([sessionCwdExists(cwd), leases.diskLockState(task_id)]);
  return { task_id, cwd, cwd_exists, lock_state };
}
async function scanDiskSessions(home, leases) {
  let root, names;
  try {
    root = getLarvaHomePaths(await canonicalPath(home)).sessions;
    await requireStateDirectory(root);
    names = await readdir(root);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw sessionReadError(error);
  }
  const sessions = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      sessions.push(await readDiskSession(home, join7(root, name), leases));
    } catch (error) {
      if (!(error instanceof LarvaError) || error.code !== "LARVA_SESSION_INVALID" && error.code !== "LARVA_SESSION_NOT_FOUND") {
        throw error;
      }
    }
  }
  return sessions;
}

// src/store/session-lease.ts
var LEASE_KEYS = ["lease_id", "owner_pid", "state", "child_pid", "capsule_root"];
var randomId = () => randomBytes2(16).toString("hex");
async function withReclaimClaim(path, observedId, recover) {
  const prefix = createHash3("sha256").update(observedId).digest("hex");
  const stage = join8(dirname5(path), `.guard.tmp.${process.pid}.${randomId()}`);
  await writeMetadata(stage, { pid: process.pid });
  try {
    for (let slot = 0; ; slot++) {
      const candidate = join8(path, `.reclaim.${prefix}.${slot}`);
      try {
        await link(stage, candidate);
        break;
      } catch (error) {
        if (isErrno(error, "ENOENT")) return false;
        if (!isErrno(error, "EEXIST")) throw error;
      }
      try {
        const info = await lstat4(candidate);
        if (!info.isFile()) return false;
        const guard = await readMetadata(candidate);
        if (!isRecord(guard)) return false;
        if (guard.done === true) continue;
        if (!isPid(guard.pid) || info.nlink !== 1 && !pidExited(guard.pid)) return false;
      } catch {
        return false;
      }
    }
    return await recover();
  } finally {
    await rm2(stage, { force: true }).catch(() => {
    });
  }
}
function createSessionLeaseStore(home, io) {
  const configuredSessions = getLarvaHomePaths(home).sessions;
  async function lockPath(taskId2) {
    const canonicalHome = await canonicalPath(home);
    const sessions = getLarvaHomePaths(canonicalHome).sessions;
    if (!taskId2.endsWith(".jsonl") || taskId2.includes("\0") || resolve4(taskId2) !== taskId2 || dirname5(taskId2) !== sessions && dirname5(taskId2) !== configuredSessions) {
      throw new LarvaError("LARVA_SESSION_INVALID", "Expected a contained .jsonl task_id.");
    }
    return { path: join8(sessions, `${basename6(taskId2)}.lock`), canonicalHome };
  }
  function parseRecord(value, canonicalHome) {
    if (!isRecord(value) || Object.keys(value).some((key) => !LEASE_KEYS.includes(key))) return void 0;
    const { lease_id, state, owner_pid, child_pid, capsule_root } = value;
    if (typeof lease_id !== "string" || !lease_id.trim() || !io.isPid(owner_pid)) return void 0;
    if ((state === "reserving" || state === "gc_unlinking") && child_pid === null && capsule_root === null) {
      return { lease_id, state, owner_pid, child_pid, capsule_root };
    }
    if (typeof capsule_root !== "string" || io.capsuleParentPid(canonicalHome, capsule_root) !== owner_pid) return void 0;
    if (state === "spawning" && child_pid === null) return { lease_id, state, owner_pid, child_pid, capsule_root };
    if (state === "running" && io.isPid(child_pid)) return { lease_id, state, owner_pid, child_pid, capsule_root };
    if (state === "unreconciled" && (child_pid === null || io.isPid(child_pid))) {
      return { lease_id, state, owner_pid, child_pid, capsule_root };
    }
    return void 0;
  }
  async function read(path, canonicalHome) {
    try {
      await requireStateDirectory(dirname5(path));
      if (!(await lstat4(path)).isDirectory()) return "invalid";
    } catch (error) {
      return isErrno(error, "ENOENT") ? "missing" : "invalid";
    }
    try {
      return parseRecord(await io.readMetadata(join8(path, "lease.json")), canonicalHome) ?? "invalid";
    } catch {
      return "invalid";
    }
  }
  async function assess(record2, canonicalHome) {
    if (!io.pidExited(record2.owner_pid)) return record2.state === "unreconciled" ? "uncertain" : "active";
    if (record2.capsule_root === null) return "stale";
    const capsule = await io.inspectCapsule(canonicalHome, record2.capsule_root, record2.child_pid);
    return capsule?.all_exited && capsule.has_child ? "stale" : "uncertain";
  }
  async function inspect(taskId2) {
    const { path, canonicalHome } = await lockPath(taskId2);
    if (Buffer.byteLength(basename6(taskId2)) > MAX_SESSION_NAME_BYTES) return { disposition: "invalid" };
    const record2 = await read(path, canonicalHome);
    if (typeof record2 === "string") return { disposition: record2 };
    return { disposition: await assess(record2, canonicalHome), record: record2 };
  }
  async function diskLockState(taskId2) {
    const lease = await inspect(taskId2);
    if (lease.disposition === "missing" || lease.disposition === "stale") return "unlocked";
    if (lease.disposition !== "active") return "unreconciled";
    return lease.record.owner_pid === process.pid ? "active_local" : "active_external";
  }
  async function detach(path) {
    const detached2 = `${path}.retired.${process.pid}.${randomId()}`;
    await rename3(path, detached2);
    await rm2(detached2, { recursive: true, force: true }).catch(() => {
    });
  }
  async function reclaimLock({ path, canonicalHome }, observedId) {
    const observed = await read(path, canonicalHome);
    if (typeof observed === "string" || observed.lease_id !== observedId || !io.pidExited(observed.owner_pid)) return false;
    const disposition = await assess(observed, canonicalHome);
    if (disposition !== "stale" && observed.state !== "spawning") return false;
    return withReclaimClaim(path, observedId, async () => {
      const current = await read(path, canonicalHome);
      if (typeof current === "string" || current.lease_id !== observedId || !io.pidExited(current.owner_pid)) return false;
      if (await assess(current, canonicalHome) === "stale") {
        await detach(path);
        return true;
      }
      if (current.state === "spawning") {
        await io.writeMetadata(join8(path, "lease.json"), { ...current, state: "unreconciled" });
      }
      return false;
    });
  }
  async function acquire(taskId2, state = "reserving") {
    const target = await lockPath(taskId2);
    if (Buffer.byteLength(basename6(taskId2)) > MAX_SESSION_NAME_BYTES) {
      throw new LarvaError("LARVA_SESSION_INVALID", `Session filename exceeds ${MAX_SESSION_NAME_BYTES} UTF-8 bytes.`);
    }
    const { path, canonicalHome } = target;
    const lease_id = randomId();
    const temp = `${path}.tmp.${process.pid}.${lease_id}`;
    const owner_pid = process.pid;
    const initial = { lease_id, owner_pid, state, child_pid: null, capsule_root: null };
    const busy = () => new LarvaError("LARVA_SESSION_BUSY", "Session already has an active or unreconciled lease.");
    await io.privateDirectory(dirname5(path));
    await mkdir3(temp, { mode: 448 });
    try {
      await io.writeMetadata(join8(temp, "lease.json"), initial);
      const current = await read(path, canonicalHome);
      if (current === "invalid") throw busy();
      if (typeof current !== "string" && !await reclaimLock(target, current.lease_id)) throw busy();
      try {
        await rename3(temp, path);
      } catch (error) {
        if (isErrno(error, "EEXIST") || isErrno(error, "ENOTEMPTY") || isErrno(error, "ENOTDIR")) throw busy();
        throw error;
      }
    } finally {
      await rm2(temp, { recursive: true, force: true }).catch(() => {
      });
    }
    let settled = Promise.resolve();
    function mutate(operation) {
      const next = settled.then(async () => {
        const current = await read(path, canonicalHome);
        if (typeof current === "string" || current.lease_id !== lease_id) throw busy();
        await operation(current);
      });
      settled = next.catch(() => {
      });
      return next;
    }
    async function publish(next) {
      await io.writeMetadata(join8(path, "lease.json"), next);
    }
    return {
      lease_id,
      markSpawning: (capsule_root) => mutate(async (current) => {
        if (current.state !== "reserving" || io.capsuleParentPid(canonicalHome, capsule_root) !== process.pid) throw busy();
        await requireStateDirectory(dirname5(capsule_root));
        if (!(await lstat4(capsule_root)).isDirectory()) throw busy();
        await io.writeMetadata(join8(capsule_root, "owner.json"), { owner_pid, state: "spawning" });
        await publish({ ...current, state: "spawning", capsule_root });
      }),
      markRunning: (child_pid) => mutate(async (current) => {
        if (current.state !== "spawning" || !io.isPid(child_pid)) throw busy();
        await io.writeMetadata(join8(current.capsule_root, "owner.json"), { owner_pid, state: "running", child_pid });
        await publish({ ...current, state: "running", child_pid });
      }),
      markUnreconciled: () => mutate(async (current) => {
        if (current.state === "unreconciled") return;
        if (current.state !== "spawning" && current.state !== "running") throw busy();
        await publish({ ...current, state: "unreconciled" });
      }),
      release: () => mutate(() => detach(path))
    };
  }
  return {
    home,
    acquire,
    inspect,
    diskLockState,
    async reclaim(taskId2, observedId) {
      const target = await lockPath(taskId2);
      return Buffer.byteLength(basename6(taskId2)) <= MAX_SESSION_NAME_BYTES && reclaimLock(target, observedId);
    }
  };
}

// src/store/persona-store.ts
var MAX_PERSONA_BYTES = 1048576;
var formats = ["md", "json"];
var maxDiagnostics = 100;
var maxCachedPersonas = 128;
var decoder2 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
var isMissing = (error) => isErrno(error, "ENOENT");
async function personaNames(directory2) {
  try {
    await requireRealDirectory(directory2);
    return new Set(await readdir2(directory2));
  } catch (error) {
    if (isMissing(error)) return /* @__PURE__ */ new Set();
    throw new LarvaError("LARVA_PERSONA_INVALID", `Cannot read persona directory: ${directory2}`);
  }
}
async function lockOwner(path) {
  await requireRealDirectory(path);
  const value = await readMetadata(join9(path, "owner.json"));
  if (!isRecord(value) || !isPid(value.pid) || typeof value.id !== "string" || !value.id) {
    throw new Error("Invalid persona write lock owner.");
  }
  return { pid: value.pid, id: value.id };
}
async function withPersonaLock(directory2, operation) {
  const path = join9(directory2, ".write.lock");
  const id = randomUUID2();
  const stage = join9(directory2, `.write.${process.pid}.${id}.tmp`);
  const retired = join9(directory2, `.write.${process.pid}.${id}.retired`);
  async function detach() {
    await rename4(path, retired);
    await rm3(retired, { recursive: true, force: true }).catch(() => {
    });
  }
  await mkdir4(stage, { mode: 448 });
  try {
    await writeMetadata(join9(stage, "owner.json"), { id, pid: process.pid });
    const deadline = performance.now() + 5e3;
    for (; ; ) {
      try {
        await rename4(stage, path);
        break;
      } catch (error) {
        if (!isErrno(error, "EEXIST") && !isErrno(error, "ENOTEMPTY")) throw error;
      }
      const observed = await lockOwner(path).catch((error) => {
        if (!isMissing(error)) throw error;
      });
      if (observed && pidExited(observed.pid) && await withReclaimClaim(path, observed.id, async () => {
        const current = await lockOwner(path).catch((error) => {
          if (!isMissing(error)) throw error;
        });
        if (current?.id !== observed.id || !pidExited(current.pid)) return false;
        await detach();
        return true;
      })) continue;
      if (performance.now() >= deadline) throw new Error("Timed out waiting for the persona write lock.");
      await delay(20);
    }
    const result2 = await operation().catch(async (error) => {
      await detach().catch(() => {
      });
      throw error;
    });
    await detach();
    return result2;
  } finally {
    await rm3(stage, { recursive: true, force: true }).catch(() => {
    });
  }
}
function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function fileFormat(path) {
  const ext = extname2(path);
  return ext === ".md" ? "md" : ext === ".json" ? "json" : void 0;
}
function candidates(directory2, names) {
  const files = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const format = fileFormat(name);
    if (!format) continue;
    files.push({ path: join9(directory2, name), id: basename7(name, `.${format}`), format });
  }
  return files.sort((a, b) => compareIds(a.id, b.id) || compareIds(a.format, b.format));
}
function conflict(id) {
  return new LarvaError("LARVA_PERSONA_CONFLICT", `Both formats exist for persona ${id}.`);
}
function notFound(id) {
  return new LarvaError("LARVA_PERSONA_NOT_FOUND", `Persona ${id} was not found.`);
}
function unreadable(path) {
  return new LarvaError("LARVA_PERSONA_INVALID", `Cannot read persona input: ${path}`);
}
function assertId(id) {
  if (!isValidPersonaId(id)) throw new LarvaError("LARVA_BAD_INPUT", "Expected a lowercase kebab-case persona ID.");
}
async function readPersonaFile(path, installed = false) {
  try {
    return await readBoundedRegularBytes(path, {
      maxBytes: MAX_PERSONA_BYTES,
      flags: installed ? constants6.O_NOFOLLOW : 0
    });
  } catch {
    throw unreadable(path);
  }
}
function parseFile(bytes, path) {
  let text2;
  try {
    text2 = decoder2.decode(bytes);
  } catch {
    throw new LarvaError("LARVA_PERSONA_INVALID", `Persona input is not UTF-8: ${path}`);
  }
  return parsePersonaInput(text2, path);
}
async function loadInput(target, { prune, stdinText }) {
  const badPrune = () => new LarvaError("LARVA_BAD_INPUT", "Prune requires a persona input directory.");
  if (target === "-") {
    if (prune) throw badPrune();
    if (stdinText === void 0) throw new LarvaError("LARVA_BAD_INPUT", "Persona stdin text is required.");
    if (Buffer.byteLength(stdinText, "utf8") > MAX_PERSONA_BYTES) {
      throw new LarvaError("LARVA_PERSONA_INVALID", "Persona stdin exceeds 1 MiB.");
    }
    const spec = parsePersonaInput(stdinText);
    return [{ spec, format: stdinText.trimStart().startsWith("{") ? "json" : "md", bytes: Buffer.from(stdinText, "utf8") }];
  }
  let files;
  try {
    const targetStat = await stat3(target);
    if (prune && !targetStat.isDirectory()) throw badPrune();
    files = [target];
    if (targetStat.isDirectory()) {
      const entries = await readdir2(target, { withFileTypes: true });
      const batch = candidates(target, entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name));
      for (let i = 1; i < batch.length; i++) {
        if (batch[i - 1].id === batch[i].id && isValidPersonaId(batch[i].id)) throw conflict(batch[i].id);
      }
      files = batch.map((file) => file.path);
    } else if (!(await readdir2(dirname6(target))).includes(basename7(target))) {
      throw new LarvaError("LARVA_PERSONA_INVALID", `Persona filename must match ${basename7(target)} exactly.`);
    }
  } catch (error) {
    if (error instanceof LarvaError) throw error;
    throw unreadable(target);
  }
  const inputs = [];
  for (const path of files) {
    const format = fileFormat(path);
    if (!format) throw new LarvaError("LARVA_PERSONA_INVALID", "Expected a .md or .json persona filename.");
    const { bytes } = await readPersonaFile(path);
    inputs.push({ spec: parseFile(bytes, path), format, bytes });
  }
  return inputs;
}
async function unlinkIfPresent(path) {
  try {
    await unlink2(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
async function stageAndRename(directory2, { spec, format, bytes }) {
  const temporary = join9(directory2, `.${randomUUID2()}.tmp`);
  const file = await open5(temporary, "wx", 384);
  try {
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    await rename4(temporary, join9(directory2, `${spec.id}.${format}`));
  } catch (error) {
    await unlinkIfPresent(temporary).catch(() => void 0);
    throw error;
  }
}
function rank(spec, query) {
  if (spec.id === query) return 0;
  if (spec.id.startsWith(query)) return 1;
  if (spec.id.includes(query)) return 2;
  return [spec.description, spec.model].some((value) => value.toLowerCase().includes(query)) ? 3 : Infinity;
}
var PersonaStore = class {
  #directory;
  #cache = /* @__PURE__ */ new Map();
  #diagnostics = [];
  constructor(home = resolveLarvaHome()) {
    this.#directory = getLarvaHomePaths(home).personas;
  }
  /** Diagnostics from the most recently completed list scan, independent of search and limit. */
  get diagnostics() {
    return this.#diagnostics.map((item) => ({ ...item }));
  }
  async validate(target, stdinText) {
    return (await loadInput(target, { stdinText })).map((input) => input.spec);
  }
  async #installed(id, names) {
    const found = [];
    for (const format of formats) {
      const name = `${id}.${format}`;
      const path = join9(this.#directory, name);
      if (names.has(name)) found.push({ path, id, format });
      else if (await entryExists(path).catch((error) => {
        if (!isErrno(error, "ENAMETOOLONG")) throw unreadable(path);
      })) {
        if ((await personaNames(this.#directory)).has(name)) found.push({ path, id, format });
        else if (await entryExists(path)) throw new LarvaError("LARVA_PERSONA_INVALID", `Persona filename must match ${name} exactly.`);
      }
    }
    return found;
  }
  async get(id) {
    assertId(id);
    return this.#get(id, await personaNames(this.#directory));
  }
  async #get(id, names) {
    try {
      const found = await this.#installed(id, names);
      if (found.length === 0) throw notFound(id);
      if (found.length > 1) throw conflict(id);
      const [{ path, format }] = found;
      const { bytes, metadata } = await readPersonaFile(path, true);
      const hash2 = createHash4("sha256").update(bytes).digest("hex");
      const fingerprint = `${format}:${metadata.dev}:${metadata.ino}:${metadata.mtimeNs}:${hash2}`;
      const cached = this.#cache.get(id);
      if (cached?.fingerprint === fingerprint) return structuredClone(cached.spec);
      const spec = parseFile(bytes, path);
      this.#cache.delete(id);
      if (this.#cache.size === maxCachedPersonas) {
        const oldest = this.#cache.keys().next();
        if (!oldest.done) this.#cache.delete(oldest.value);
      }
      this.#cache.set(id, { fingerprint, spec });
      return structuredClone(spec);
    } catch (error) {
      this.#cache.delete(id);
      throw error;
    }
  }
  async list({ full, query, limit } = {}) {
    if (limit !== void 0 && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new LarvaError("LARVA_BAD_INPUT", "Persona list limit must be a positive integer.");
    }
    const diagnostics = [];
    let names;
    try {
      names = await personaNames(this.#directory);
    } catch (error) {
      if (!(error instanceof LarvaError)) throw error;
      this.#diagnostics = [{ code: error.code, message: error.message, path: this.#directory }];
      return [];
    }
    const valid = [];
    const checked = /* @__PURE__ */ new Set();
    for (const { id, path } of candidates(this.#directory, names)) {
      if (!isValidPersonaId(id)) {
        if (diagnostics.length < maxDiagnostics) diagnostics.push({
          code: "LARVA_PERSONA_INVALID",
          message: "Invalid persona filename stem.",
          path
        });
        continue;
      }
      if (checked.has(id)) continue;
      checked.add(id);
      try {
        const spec = await this.#get(id, names);
        valid.push(full ? spec : toPersonaSummary(spec));
      } catch (error) {
        if (!(error instanceof LarvaError)) throw error;
        if (diagnostics.length < maxDiagnostics) diagnostics.push({
          code: error.code,
          persona_id: id,
          message: error.message,
          ...error.code === "LARVA_PERSONA_CONFLICT" ? {} : { path }
        });
      }
    }
    this.#diagnostics = diagnostics;
    const needle = query?.trim().toLowerCase();
    const matches2 = needle ? valid.map((spec) => ({ spec, score: rank(spec, needle) })).filter((item) => Number.isFinite(item.score)).sort((a, b) => a.score - b.score || compareIds(a.spec.id, b.spec.id)).map((item) => item.spec) : valid;
    const selected = matches2.slice(0, limit);
    return full ? selected.filter((spec) => "prompt" in spec) : selected;
  }
  async put(target, options = {}) {
    const prune = options.prune;
    const inputs = await loadInput(target, options);
    const committed_ids = [];
    const pruned = /* @__PURE__ */ new Set();
    let failed_id = inputs[0]?.spec.id ?? null;
    try {
      await mkdir4(dirname6(this.#directory), { recursive: true, mode: 448 });
      await requireRealDirectory(this.#directory, true);
      return await withPersonaLock(this.#directory, async () => {
        const names = await personaNames(this.#directory);
        for (const { spec } of inputs) {
          failed_id = spec.id;
          await this.#installed(spec.id, names);
        }
        for (const input of inputs) {
          failed_id = input.spec.id;
          this.#cache.delete(failed_id);
          await stageAndRename(this.#directory, input);
          committed_ids.push(failed_id);
          const other = input.format === "md" ? "json" : "md";
          const otherName = `${failed_id}.${other}`;
          if (names.has(otherName)) await unlinkIfPresent(join9(this.#directory, otherName));
        }
        if (prune) {
          failed_id = null;
          const incoming = new Set(committed_ids);
          const files = candidates(this.#directory, await readdir2(this.#directory));
          for (const { path, id } of files) {
            if (incoming.has(id)) continue;
            failed_id = id;
            this.#cache.delete(id);
            if (await unlinkIfPresent(path)) pruned.add(id);
          }
        }
        failed_id = null;
        return { committed_ids, pruned_ids: [...pruned] };
      });
    } catch (error) {
      const detail2 = error instanceof Error ? ` ${error.message}` : "";
      throw new LarvaError("LARVA_STORE_WRITE_FAILED", `Could not finish writing the persona store.${detail2}`, {
        committed_ids,
        pruned_ids: [...pruned],
        failed_id
      });
    }
  }
  async rm(ids) {
    const requested = [...new Set(ids)];
    requested.forEach(assertId);
    if (requested.length === 0) return;
    let failed_id = requested[0];
    try {
      await requireRealDirectory(this.#directory);
    } catch (error) {
      if (isMissing(error)) throw notFound(failed_id);
      throw new LarvaError("LARVA_STORE_WRITE_FAILED", `Cannot access persona directory: ${this.#directory}`);
    }
    try {
      await withPersonaLock(this.#directory, async () => {
        const names = await personaNames(this.#directory);
        const removal = [];
        for (const id of requested) {
          const files = await this.#installed(id, names);
          if (files.length === 0) throw notFound(id);
          removal.push(...files);
        }
        for (const { id, path } of removal) {
          failed_id = id;
          this.#cache.delete(id);
          await unlinkIfPresent(path);
        }
      });
    } catch (error) {
      if (error instanceof LarvaError) throw error;
      throw new LarvaError("LARVA_STORE_WRITE_FAILED", `Could not remove persona ${failed_id}.`, { failed_id });
    }
  }
};

// src/runtime/child-rpc-client.ts
import { spawn } from "node:child_process";
import { dirname as dirname7 } from "node:path";
import { pathToFileURL } from "node:url";
var MAX_RECORD = 1048576;
var GRACE_MS = 1500;
var protocol = (message) => new LarvaError("LARVA_CHILD_PROTOCOL_FAILED", message);
var STDERR_LIMIT = 8192;
var SECRET_NAMES = "(?:(?:[a-z0-9]+[_-])*api[_-]?key|key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)";
var SECRET_KEY = new RegExp(`^${SECRET_NAMES}$`, "i");
var SECRET_ASSIGNMENT = new RegExp(String.raw`["']?\b${SECRET_NAMES}\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer|Basic)\s+\S+|\S+)`, "gi");
function redactCredentials(raw) {
  return raw.replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@").replace(SECRET_ASSIGNMENT, "[REDACTED]").replace(/\b(?:Bearer|Basic)\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|\bAIza[0-9A-Za-z_-]{16,}/gi, "[REDACTED]");
}
function sanitizeRpcError(raw) {
  const clean = redactCredentials(raw.replace(/\s+/g, " ").trim());
  return Array.from(clean.slice(0, 600)).slice(0, 300).join("");
}
function previewToolArgs(args) {
  try {
    const serialized = JSON.stringify(args, (key, value) => SECRET_KEY.test(key) ? "[REDACTED]" : typeof value === "string" ? redactCredentials(value) : value);
    return serialized === void 0 ? void 0 : Array.from(serialized.slice(0, 320)).slice(0, 160).join("");
  } catch {
    return void 0;
  }
}
function startupError(line) {
  let frame;
  try {
    frame = JSON.parse(line.toString("utf8"));
  } catch {
    return;
  }
  if (!isRecord(frame) || frame.ok !== false || !isRecord(frame.error)) return;
  const { code, message } = frame.error;
  const knownCode = ALL_LARVA_ERROR_CODES.find((value) => value === code);
  if (knownCode && typeof message === "string") return new LarvaError(knownCode, sanitizeRpcError(message) || "Pi startup failed.");
}
function fitsPrompt(message) {
  return message.length < MAX_RECORD && Buffer.byteLength(JSON.stringify({ type: "prompt", id: "0".repeat(24), message })) <= MAX_RECORD;
}
function launchChild(options, progress, telemetry) {
  const { piScript, extension, preload, extensionSources, env, home, basePiAgentDir, capsule, agentDir, cwd, taskId: taskId2, depth, ancestors, persona, route, thinking } = options;
  const child = spawn(process.execPath, [
    piScript,
    "--mode",
    "rpc",
    "--no-extensions",
    "-e",
    extension,
    ...extensionSources.flatMap((source) => ["-e", source]),
    "--larva-persona",
    persona,
    "--larva-mode",
    "manual",
    "--model",
    `${route.provider}/${route.model_id}`,
    "--thinking",
    thinking,
    "--session-dir",
    dirname7(taskId2),
    "--session",
    taskId2
  ], {
    cwd,
    stdio: "pipe",
    env: {
      ...env,
      NODE_OPTIONS: [`--import=${pathToFileURL(preload).href}`, env.NODE_OPTIONS].filter(Boolean).join(" "),
      LARVA_HOME: home,
      LARVA_PI_LAUNCHED: "1",
      LARVA_PI_INITIAL_PERSONA_ID: persona,
      LARVA_PI_CAPSULE_ROOT: capsule,
      [BASE_PI_AGENT_DIR_ENV]: basePiAgentDir,
      PI_CODING_AGENT_DIR: agentDir,
      LARVA_PI_SUBAGENT_DEPTH: String(depth),
      LARVA_PI_ANCESTOR_TASK_IDS: JSON.stringify(ancestors)
    }
  });
  return new ChildRpcClient(child, progress, telemetry);
}
var ChildRpcClient = class {
  #child;
  #terminal = Promise.withResolvers();
  #exit = Promise.withResolvers();
  #readinessDeadline = performance.now() + 6e4;
  #requests = /* @__PURE__ */ new Map();
  #error;
  #shutdown;
  #sequence = 0;
  #promptSent = false;
  #ready = false;
  get pid() {
    return this.#child.pid;
  }
  get settled() {
    return this.#terminal.promise;
  }
  constructor(child, progress, telemetry) {
    this.#child = child;
    this.settled.catch(() => {
    });
    let stderr = Buffer.alloc(0), discarding = false;
    let diagnostic, readError;
    child.stderr.on("data", (chunk) => {
      if (this.#ready || diagnostic) return;
      for (let start = 0; start < chunk.length; ) {
        const lf = chunk.indexOf(10, start), end = lf < 0 ? chunk.length : lf;
        discarding ||= end - start > STDERR_LIMIT - stderr.length;
        if (!discarding) stderr = Buffer.concat([stderr, chunk.subarray(start, end)]);
        if (lf < 0) break;
        if (!discarding && (diagnostic = startupError(stderr))) break;
        stderr = Buffer.alloc(0);
        discarding = false;
        start = lf + 1;
      }
    });
    child.on("error", () => this.#fail(new LarvaError("LARVA_CHILD_START_FAILED", "Could not launch the Pi child.")));
    child.stdin.on("error", () => {
      if (this.#ready) this.#fail(protocol("Child RPC input closed."));
    });
    child.once("exit", () => this.#exit.resolve());
    const read = this.#read(progress, telemetry).catch((error) => {
      readError = error instanceof LarvaError ? error : protocol("Malformed or oversized child RPC frame.");
      if (this.#ready) this.#fail(readError);
    });
    child.once("close", (code) => {
      this.#exit.resolve();
      void read.then(() => {
        const startup = !this.#ready && code !== null && code !== 0 ? diagnostic ?? (!discarding ? startupError(stderr) : void 0) : void 0;
        this.#fail(startup ?? readError ?? protocol("Child exited before RPC completed."));
      });
    });
  }
  #fail(error) {
    this.#error ??= error;
    this.#terminal.reject(this.#error);
    for (const request of this.#requests.values()) request.reject(this.#error);
    this.#requests.clear();
  }
  async #read(progress, telemetry) {
    const buffer = Buffer.allocUnsafe(MAX_RECORD);
    const decoder5 = new TextDecoder("utf-8", { fatal: true });
    let used = 0;
    let stopReason;
    for await (const chunk of this.#child.stdout) {
      for (let start = 0; start < chunk.length; ) {
        const lf = chunk.indexOf(10, start);
        const end = lf === -1 ? chunk.length : lf;
        if (end - start > MAX_RECORD - used) throw protocol("Oversized frame.");
        used += chunk.copy(buffer, used, start, end);
        if (lf === -1) break;
        start = lf + 1;
        const frame = JSON.parse(decoder5.decode(buffer.subarray(0, used)));
        used = 0;
        if (!isRecord(frame) || typeof frame.type !== "string") throw protocol("Invalid frame.");
        if (frame.type === "larva_rpc_frame_error") {
          throw protocol(isRecord(frame.error) && typeof frame.error.message === "string" ? sanitizeRpcError(frame.error.message) : "Invalid frame.");
        }
        if (frame.type === "larva_assistant_text_chunk") {
          const request = typeof frame.id === "string" && this.#requests.get(frame.id);
          if (!request) continue;
          if (!request.chunks || typeof frame.text !== "string") throw protocol("Invalid assistant text chunk.");
          request.chunks.push(frame.text);
          continue;
        }
        if (frame.type === "response") {
          if (typeof frame.id !== "string") continue;
          const request = this.#requests.get(frame.id);
          if (!request) continue;
          if (frame.command !== request.type || typeof frame.success !== "boolean") throw protocol("Invalid response.");
          if (frame.success && frame.data != null && !isRecord(frame.data)) throw protocol("Invalid response data.");
          this.#requests.delete(frame.id);
          if (!frame.success) {
            const detail2 = typeof frame.error === "string" ? sanitizeRpcError(frame.error) : "";
            request.reject(protocol(detail2 ? `Child rejected ${request.type}: ${detail2}` : `Child rejected ${request.type}.`));
          } else {
            const data = isRecord(frame.data) ? frame.data : {};
            if (request.type === "prompt" && data.disposition !== "handled") this.#promptSent = true;
            if (request.chunks && data.chunked === true && request.chunks.length) request.resolve({ text: request.chunks.join("") });
            else if (request.chunks && (data.chunked === true || request.chunks.length)) request.reject(protocol("Incomplete assistant text response."));
            else request.resolve(data);
          }
          continue;
        }
        if (!this.#promptSent || this.#error) continue;
        telemetry(frame);
        if (frame.type === "agent_settled") {
          if (typeof frame.aborted !== "boolean") throw protocol("Malformed terminal frame.");
          if (frame.aborted || stopReason === "aborted") this.#terminal.reject(new LarvaError("LARVA_CHILD_CANCELLED", "Child aborted."));
          else if (stopReason === "error") this.#terminal.reject(protocol("Child assistant turn failed."));
          else this.#terminal.resolve();
        } else if (frame.type === "agent_start") stopReason = void 0;
        else if (frame.type === "message_end" && isRecord(frame.message) && frame.message.role === "assistant") stopReason = frame.message.stopReason;
        else if (frame.type === "agent_end") {
          if (Array.isArray(frame.messages)) stopReason = frame.messages.findLast((m) => isRecord(m) && m.role === "assistant")?.stopReason ?? stopReason;
          progress();
        } else if (["tool_execution_start", "tool_execution_update", "tool_execution_end", "larva_descendant_progress"].includes(frame.type)) progress();
        else if (frame.type === "message_update" && isRecord(frame.assistantMessageEvent)) {
          const e = frame.assistantMessageEvent;
          if (e.type === "thinking_start" || e.type === "thinking_end" || ["text_delta", "thinking_delta", "toolcall_delta"].includes(String(e.type)) && typeof e.delta === "string" && e.delta.trim()) progress();
        }
      }
    }
    if (this.#ready) this.#fail(protocol("Child RPC stream closed."));
  }
  async #command(type, fields = {}, timeoutMs = 3e4) {
    if (this.#error) throw this.#error;
    if (timeoutMs <= 0) throw protocol(`Child ${type} timed out.`);
    const id = String(++this.#sequence);
    const response = Promise.withResolvers();
    const line = JSON.stringify({ type, id, ...fields });
    if (Buffer.byteLength(line) > MAX_RECORD) throw protocol("RPC command exceeds the record limit.");
    this.#requests.set(id, { type, ...response, ...type === "get_last_assistant_text" && { chunks: [] } });
    const timer = setTimeout(() => response.reject(protocol(`Child ${type} timed out.`)), timeoutMs);
    try {
      this.#child.stdin.write(`${line}
`);
      return await response.promise;
    } finally {
      clearTimeout(timer);
      this.#requests.delete(id);
    }
  }
  async resume(taskId2) {
    const reply = await this.#command("switch_session", { sessionPath: taskId2 }, this.#readinessDeadline - performance.now());
    if (reply.cancelled !== false) throw protocol("Child did not confirm session switch.");
  }
  async verify(route, thinking, taskId2, persona) {
    const s = await this.#command("get_state", {}, this.#readinessDeadline - performance.now());
    const cap = s.larvaChildRpcFrame;
    if (!isRecord(cap) || cap.capability !== "larva-child-rpc-frame-preload-v1" || cap.framing !== "lf-only" || cap.max_record_bytes !== MAX_RECORD || cap.terminal !== "agent_settled") throw protocol("Missing child preload capability.");
    if (s.sessionFile !== taskId2 || s.persona_id !== persona) throw protocol("Child session or persona mismatch.");
    if (!isRecord(s.model) || s.model.provider !== route.provider || s.model.id !== route.model_id || s.thinkingLevel !== (s.model.reasoning === false ? "off" : thinking)) {
      throw new LarvaError("LARVA_MODEL_UNAVAILABLE", "Child did not verify the required model and thinking level.");
    }
    this.#ready = true;
    return s.model.reasoning === false ? "off" : thinking;
  }
  async setRoute(route, thinking) {
    await this.#command("set_model", { provider: route.provider, modelId: route.model_id }, this.#readinessDeadline - performance.now());
    await this.#command("set_thinking_level", { level: thinking }, this.#readinessDeadline - performance.now());
  }
  async prompt(message) {
    if ((await this.#command("prompt", { message })).disposition === "handled") throw protocol("Child handled prompt without starting a run.");
  }
  async output() {
    const { text: text2 } = await this.#command("get_last_assistant_text");
    if (text2 == null) return "";
    if (typeof text2 !== "string") throw protocol("Child did not return assistant text.");
    return text2;
  }
  stop(abort) {
    this.#fail(abort ? new LarvaError("LARVA_CHILD_CANCELLED", "Child is stopping.") : protocol("Child RPC is closing."));
    return this.#shutdown ??= this.#stop(abort).catch(() => false);
  }
  async #stop(abort) {
    const child = this.#child;
    if (abort && child.stdin.writable) child.stdin.write('{"type":"abort"}\n');
    child.stdin.end();
    const exited = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      let timer;
      try {
        return await Promise.race([this.#exit.promise.then(() => true), new Promise((r) => {
          timer = setTimeout(() => r(false), GRACE_MS);
        })]);
      } finally {
        clearTimeout(timer);
      }
    };
    if (await exited()) return true;
    child.kill("SIGKILL");
    return exited();
  }
};

// src/runtime/outbox.ts
import { randomUUID as randomUUID3 } from "node:crypto";
var mintRunEpoch = () => randomUUID3();
function isTerminal(status) {
  return status === "success" || status === "failed" || status === "cancelled";
}
var RunOutbox = class {
  #completed = /* @__PURE__ */ new Map();
  retain(snapshot, prompt) {
    this.#completed.set(snapshot.run_epoch, { snapshot, prompt });
    if (this.#completed.size <= 25) return;
    const { snapshot: oldest } = this.#completed.values().next().value;
    this.#completed.delete(oldest.run_epoch);
    delete oldest.result_text;
    delete oldest.result_preview;
    delete oldest.full_output_artifact;
    delete oldest.output_diagnostic;
    oldest.output_state = "evicted";
  }
  publish(snapshot, output) {
    if (this.#completed.get(snapshot.run_epoch)?.snapshot === snapshot) Object.assign(snapshot, output);
  }
  prompt(epoch) {
    return this.#completed.get(epoch)?.prompt;
  }
  recent() {
    return [...this.#completed.values()].reverse().map((entry) => entry.snapshot);
  }
  lookup(taskId2, epoch) {
    if (epoch === void 0) return this.recent().find((s2) => s2.task_id === taskId2);
    const s = this.#completed.get(epoch)?.snapshot;
    return s?.task_id === taskId2 ? s : void 0;
  }
};
function terminalOutput(snapshot, output = snapshot) {
  const { task_id, run_epoch, persona_id, phase, status, error } = snapshot;
  const { output_state, result_text, result_preview, full_output_artifact, output_diagnostic } = output;
  if (!isTerminal(status)) throw new Error("Expected terminal execution status.");
  return structuredClone({
    task_id,
    run_epoch,
    persona_id,
    phase,
    status,
    output_state,
    ...error && { error },
    ...result_text !== void 0 && { result_text },
    ...result_preview !== void 0 && { result_preview },
    ...full_output_artifact && { full_output_artifact },
    ...output_diagnostic && { output_diagnostic }
  });
}

// src/runtime/pi-binary.ts
import { constants as constants7 } from "node:fs";
import { access as access2, realpath as realpath5, stat as stat4 } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { basename as basename8, delimiter, dirname as dirname8, isAbsolute as isAbsolute3, join as join10, relative as relative2, resolve as resolve5, sep as sep2 } from "node:path";
import { pathToFileURL as pathToFileURL2 } from "node:url";
var PI_PACKAGE = "@earendil-works/pi-coding-agent";
var MAX_MANIFEST_BYTES = 1048576;
function isWithin(root, path) {
  const rel = relative2(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep2}`) && !isAbsolute3(rel);
}
async function registryEntry(directory2, pkg) {
  const exported = isRecord(pkg.exports) ? pkg.exports["."] : pkg.exports;
  const entry = typeof exported === "string" ? exported : isRecord(exported) ? exported.import : pkg.main;
  if (typeof entry !== "string" || entry.length === 0 || isAbsolute3(entry)) return void 0;
  try {
    const path = await realpath5(resolve5(directory2, entry));
    return isWithin(directory2, path) && (await stat4(path)).isFile() ? path : void 0;
  } catch {
    return void 0;
  }
}
async function inspectPiScript(candidate) {
  try {
    const path = await realpath5(candidate);
    if (!(await stat4(path)).isFile()) return void 0;
    await access2(path, constants7.R_OK);
    let directory2 = dirname8(path);
    for (; ; ) {
      let raw;
      try {
        raw = await readBoundedRegularText(join10(directory2, "package.json"), { maxBytes: MAX_MANIFEST_BYTES });
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT" || dirname8(directory2) === directory2) return void 0;
        directory2 = dirname8(directory2);
        continue;
      }
      const pkg = JSON.parse(raw);
      if (!isRecord(pkg) || pkg.name !== PI_PACKAGE || !isRecord(pkg.bin) || typeof pkg.bin.pi !== "string" || !pkg.bin.pi.trim() || isAbsolute3(pkg.bin.pi) || await realpath5(resolve5(directory2, pkg.bin.pi)) !== path) return void 0;
      const entry = await registryEntry(directory2, pkg);
      return {
        path,
        ...typeof pkg.version === "string" && pkg.version ? { version: pkg.version } : {},
        ...entry === void 0 ? {} : { registryEntry: entry }
      };
    }
  } catch {
    return void 0;
  }
}
async function inspectManagedLauncher(candidate) {
  try {
    const launcher = await realpath5(candidate);
    if (basename8(launcher) !== "pi" || basename8(dirname8(launcher)) !== "bin" || !(await stat4(launcher)).isFile()) return void 0;
    const install = await realpath5(join10(dirname8(dirname8(launcher)), "install"));
    const release = (await readBoundedRegularText(join10(install, "current-version"), { maxBytes: 256 })).trim();
    if (!/^[0-9A-Za-z._+-]+$/.test(release) || release === "." || release === "..") return void 0;
    const releaseRoot = join10(install, "releases", release);
    const bin = join10(releaseRoot, "node_modules", ".bin", "pi");
    await access2(bin, constants7.X_OK);
    const verified = await inspectPiScript(bin);
    return verified && isWithin(releaseRoot, verified.path) ? verified : void 0;
  } catch {
    return void 0;
  }
}
async function discoverPiInstallation(env = process.env) {
  const override = env.LARVA_PI_CLI_SCRIPT;
  if (override !== void 0) {
    if (override.trim() && isAbsolute3(override) && !override.includes("\0")) {
      const verified = await inspectPiScript(override);
      if (verified) return verified;
    }
    throw new LarvaError("LARVA_CHILD_START_FAILED", "LARVA_PI_CLI_SCRIPT must be an absolute path to a verified Pi package bin.pi script.");
  }
  const home = env.HOME || homedir3();
  const directories = /* @__PURE__ */ new Set([
    ...(env.PATH ?? "").split(delimiter),
    join10(home, ".local", "bin"),
    join10(home, ".pi", "agent", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin"
  ]);
  for (const directory2 of directories) {
    if (!isAbsolute3(directory2)) continue;
    const candidate = join10(directory2, "pi");
    try {
      await access2(candidate, constants7.X_OK);
    } catch {
      continue;
    }
    const verified = await inspectPiScript(candidate) ?? await inspectManagedLauncher(candidate);
    if (verified) return verified;
  }
  throw new LarvaError("LARVA_CHILD_START_FAILED", "No verified Pi installation found on PATH; set LARVA_PI_CLI_SCRIPT to the package bin.pi script.");
}

// src/runtime/settlement-barrier.ts
function childSettlementBarrier() {
  const pending = /* @__PURE__ */ new Map();
  let continuation;
  let scheduled = false;
  let parked;
  let bridge;
  let branch = () => [];
  let lastHeartbeat = -Infinity;
  function release() {
    if (parked === void 0 || pending.size) return;
    const frame = parked;
    parked = void 0;
    bridge?.emit([frame]);
  }
  function wake() {
    if (scheduled || !continuation || parked === void 0) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (parked === void 0 || !continuation?.isIdle()) return;
      const queued = [...pending].filter(([, state]) => state === "queued");
      if (!queued.length) return;
      for (const [id] of queued) pending.set(id, "redriven");
      try {
        void Promise.resolve(continuation.triggerTurn()).catch(() => {
        });
      } catch {
      }
    });
  }
  return {
    /** Reserve before asynchronous child admission, so an intervening agent_settled cannot escape. */
    register(kind, callbackId) {
      if (kind === "larva-subagent-result") pending.set(callbackId, "reserved");
    },
    delivery(callbackId, state) {
      if (state === "delivered" && pending.get(callbackId) === "reserved") {
        pending.set(callbackId, "queued");
        wake();
      }
      if (state === "failed" || state === "suppressed" || state === "stale") {
        pending.delete(callbackId);
        release();
      }
    },
    unbind() {
      continuation = void 0;
    },
    retire() {
      pending.clear();
      parked = void 0;
    },
    relayProgress() {
      const time = performance.now();
      if (!bridge || time - lastHeartbeat < 1e3) return;
      lastHeartbeat = time;
      bridge.emit([{ type: "larva_descendant_progress" }]);
    },
    bind(next, getBranch, getActivePersona, idleContinuation) {
      bridge = next;
      continuation = idleContinuation;
      wake();
      branch = getBranch;
      next.configure((frame) => {
        if (getActivePersona && frame.type === "response" && frame.command === "get_state" && frame.success === true && isRecord(frame.data)) {
          return [{ ...frame, data: { ...frame.data, persona_id: getActivePersona() } }];
        }
        if (frame.type === "agent_start") parked = void 0;
        if (pending.size && frame.type === "extension_error" && frame.extensionPath === "<runtime>" && frame.event === "send_message") {
          pending.clear();
          parked = void 0;
          return [{ type: "larva_rpc_frame_error", error: { code: "LARVA_CHILD_PROTOCOL_FAILED", message: "Could not correlate a child callback delivery error." } }];
        }
        if (frame.type !== "agent_settled" || !pending.size) return [frame];
        if (frame.aborted === true) {
          parked = void 0;
          pending.clear();
          return [frame];
        }
        let assistant = false;
        const entries = branch();
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (!isRecord(e)) continue;
          if (e.type === "message" && isRecord(e.message) && e.message.role === "assistant") assistant = true;
          const details = e.type === "custom_message" ? e.details : e.type === "custom" ? e.data : void 0;
          if (assistant && e.customType === "larva-subagent-result" && isRecord(details) && typeof details.callback_id === "string") pending.delete(details.callback_id);
        }
        if (!pending.size) {
          parked = void 0;
          return [frame];
        }
        parked = frame;
        wake();
        return [];
      });
    }
  };
}

// src/runtime/supervisor.ts
var bad = (message) => {
  throw new LarvaError("LARVA_BAD_INPUT", message);
};
var cancelled = (message) => new LarvaError("LARVA_CHILD_CANCELLED", message);
var now = () => (/* @__PURE__ */ new Date()).toISOString();
function keys(value, names) {
  if (!isRecord(value) || Object.keys(value).some((k) => !names.includes(k))) bad("Invalid or unknown input fields.");
}
async function directory(path, code) {
  try {
    if (isAbsolute4(path) && (await stat5(path)).isDirectory()) return await realpath6(path);
  } catch {
  }
  throw new LarvaError(code, "Workspace must be an existing absolute directory.");
}
async function workspace(home, input, ctx) {
  if (input.task_id !== void 0) {
    const h = await readSessionHeader(home, input.task_id);
    const cwd = await directory(h.cwd, "LARVA_CHILD_START_FAILED");
    if (input.cwd !== void 0 && await directory(input.cwd, "LARVA_BAD_INPUT") !== cwd) bad("Workspace differs from the recorded session.");
    return { cwd, taskId: h.task_id };
  }
  if (input.cwd !== void 0) return { cwd: await directory(input.cwd, "LARVA_BAD_INPUT") };
  if (ctx.surface === "pi") return { cwd: await directory(ctx.cwd, "LARVA_CWD_REQUIRED") };
  try {
    const roots = (await ctx.listRoots?.())?.roots;
    if (Array.isArray(roots) && roots.length === 1 && typeof roots[0]?.uri === "string" && /^file:\/\//i.test(roots[0].uri)) {
      const u = new URL(roots[0].uri);
      if (u.protocol === "file:" && !u.host && !u.search && !u.hash) return { cwd: await directory(fileURLToPath(u), "LARVA_CWD_REQUIRED") };
    }
  } catch {
  }
  throw new LarvaError("LARVA_CWD_REQUIRED", "Provide cwd when there is not exactly one usable local workspace root.");
}
async function lineage(env, root, self) {
  const invalid6 = () => {
    throw new LarvaError("LARVA_CHILD_START_FAILED", "Invalid or over-limit subagent lineage.");
  };
  const rawDepth = env.LARVA_PI_SUBAGENT_DEPTH ?? (env.LARVA_PI_LAUNCHED === "1" ? "1" : "0");
  if (!/^(0|[1-9][0-9]?)$/.test(rawDepth) || env.LARVA_PI_LAUNCHED === "1" && rawDepth === "0") return invalid6();
  const depth = Number(rawDepth);
  const raw = env.LARVA_PI_ANCESTOR_TASK_IDS ?? "[]";
  if (Buffer.byteLength(raw) > 65536) return invalid6();
  let ids;
  try {
    ids = JSON.parse(raw);
  } catch {
    return invalid6();
  }
  if (!Array.isArray(ids) || ids.length > 100) return invalid6();
  const ancestors = /* @__PURE__ */ new Set();
  for (const id of [...ids, ...self !== void 0 && (depth > 0 || isLexicallyContained(root, self)) ? [self] : []]) {
    if (typeof id !== "string" || !isLexicallyContained(root, id) || resolve6(id) !== id || !id.endsWith(".jsonl")) return invalid6();
    try {
      if (join11(await realpath6(dirname9(id)), basename9(id)) !== id || await entryExists(id) && (!(await lstat5(id)).isFile() || await realpath6(id) !== id)) return invalid6();
    } catch {
      return invalid6();
    }
    ancestors.add(id);
  }
  if (ancestors.size > 100 || Buffer.byteLength(JSON.stringify([...ancestors])) > 65536) return invalid6();
  return { depth, ancestors: [...ancestors] };
}
function clearTimers(run) {
  clearTimeout(run.stall);
  clearTimeout(run.watchdog);
}
function clearLive(run) {
  run.activeTools.clear();
  run.s.active_tool = null;
  run.s.live_thinking = false;
}
function toolText(result2) {
  if (!isRecord(result2) || !Array.isArray(result2.content)) return void 0;
  let text2 = "";
  for (const part of result2.content) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
    text2 += `${text2 ? "\n" : ""}${part.text.slice(0, 600)}`;
    if (text2.length >= 600) break;
  }
  return text2 ? sanitizeRpcError(text2) : void 0;
}
async function diskPrompt(home, taskId2) {
  await readSessionHeader(home, taskId2);
  const file = await open6(taskId2, constants8.O_RDONLY | constants8.O_NONBLOCK | constants8.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size === 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) return;
    const decoder5 = new TextDecoder("utf-8", { fatal: true });
    const buffer = Buffer.alloc(64 * 1024), parts = [];
    let prompt;
    const consume = (line) => {
      if (!line) return true;
      const entry = JSON.parse(line);
      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") return true;
      if (prompt !== void 0) return false;
      const { content } = entry.message;
      if (typeof content === "string") prompt = content;
      else if (Array.isArray(content)) prompt = content.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("");
      return prompt !== void 0;
    };
    for (let remaining = Number(before.size); remaining > 0; ) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (!bytesRead) return;
      remaining -= bytesRead;
      const lines = decoder5.decode(buffer.subarray(0, bytesRead), { stream: remaining > 0 }).split("\n");
      const tail = lines.pop();
      for (const line of lines) {
        parts.push(line);
        if (!consume(parts.join(""))) return;
        parts.length = 0;
      }
      parts.push(tail);
    }
    if (!consume(parts.join(""))) return;
    const after = await file.stat({ bigint: true });
    if (before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs) return prompt;
  } finally {
    await file.close();
  }
}
async function terminateDescendants(home, root, rpc, stopping) {
  const live = async () => (await inspectDescendantPids(home, root)).pids.filter((pid) => pid !== rpc.pid && pid !== process.pid && pid !== process.ppid && !pidExited(pid));
  const signal = (pid, sig) => {
    try {
      process.kill(pid, sig);
    } catch {
    }
  };
  const deadline = performance.now() + GRACE_MS;
  for (const pid of await live()) signal(pid, "SIGTERM");
  await stopping;
  let pids = await live();
  if (!pids.length) return;
  if (deadline > performance.now()) await delay2(deadline - performance.now());
  pids = await live();
  for (const pid of pids) signal(pid, "SIGKILL");
  const confirmation = performance.now() + GRACE_MS;
  while (pids.some((pid) => !pidExited(pid)) && performance.now() < confirmation) await delay2(25);
}
function applyTelemetry(run, frame) {
  const { s, activeTools } = run;
  switch (frame.type) {
    case "turn_end":
    case "agent_settled": {
      const changed = !!(s.active_tool || s.live_thinking);
      clearLive(run);
      return changed;
    }
    case "message_start":
      if (!isRecord(frame.message) || frame.message.role !== "assistant") return false;
      s.live_assistant_preview = "";
      s.live_thinking = false;
      return true;
    case "message_update": {
      const e = frame.assistantMessageEvent;
      if (!isRecord(e)) return false;
      if (e.type === "text_delta" && typeof e.delta === "string") {
        s.live_thinking = false;
        s.live_assistant_preview = Array.from(((s.live_assistant_preview ?? "") + e.delta.slice(-1200)).slice(-1200)).slice(-600).join("");
        return true;
      }
      if (e.type === "thinking_start" || e.type === "thinking_end") {
        s.live_thinking = e.type === "thinking_start";
        return true;
      }
      return false;
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const { toolCallId, toolName } = frame;
      if (typeof toolCallId !== "string" || typeof toolName !== "string") return false;
      const tool2 = {
        tool_call_id: toolCallId,
        name: toolName,
        status: frame.type === "tool_execution_end" ? frame.isError === true ? "error" : "done" : "running"
      };
      const snapshots = [...s.tool_snapshots ?? []];
      const index = snapshots.findIndex((t) => t.tool_call_id === toolCallId);
      const starting = frame.type === "tool_execution_start";
      if (starting) s.tool_call_count++;
      if (index !== -1 || starting) {
        const row = { ...starting ? void 0 : snapshots[index], ...tool2 };
        if (frame.args !== void 0) row.args_preview = previewToolArgs(frame.args);
        const text2 = toolText(frame.type === "tool_execution_update" ? frame.partialResult : frame.result);
        if (text2 !== void 0) row[frame.isError === true ? "error_preview" : "output_preview"] = text2;
        if (starting) {
          if (index !== -1) snapshots.splice(index, 1);
          snapshots.push(row);
        } else snapshots[index] = row;
        s.tool_snapshots = snapshots.slice(-25);
      }
      activeTools.delete(toolCallId);
      if (frame.type === "tool_execution_end") {
        if (s.active_tool?.tool_call_id === toolCallId) s.active_tool = [...activeTools.values()].at(-1) ?? null;
      } else {
        activeTools.set(toolCallId, tool2);
        s.active_tool = tool2;
      }
      return true;
    }
    default:
      return false;
  }
}
var SubagentSupervisor = class {
  home;
  barrier = childSettlementBarrier();
  #opts;
  #env;
  #baseCwd = process.cwd();
  #personas;
  #leases;
  #active = /* @__PURE__ */ new Map();
  // Includes startup and unconfirmed ownership.
  #outbox = new RunOutbox();
  #failures = [];
  #observers = /* @__PURE__ */ new Set();
  #callbacks = /* @__PURE__ */ new Map();
  #activity = /* @__PURE__ */ new WeakMap();
  #activitySequence = 0;
  #binding;
  #sessionKey;
  #sessionEpoch = 0;
  #reloading = false;
  #closing = false;
  #profile;
  #generation = 0;
  #telemetryTimer;
  constructor(options = {}) {
    this.#opts = options;
    this.#env = options.env ?? process.env;
    this.home = options.home ?? resolveLarvaHome(this.#env);
    this.#leases = createSessionLeaseStore(this.home, capsule_exports);
    this.#personas = new PersonaStore(this.home);
    this.#profile = this.#env.LARVA_PI_MODEL_MAP_PROFILE ?? "default";
  }
  beginReload() {
    this.#reloading = true;
    this.#binding = void 0;
    this.barrier.unbind();
  }
  rebind(binding) {
    if (this.#sessionKey !== void 0 && this.#sessionKey !== binding.sessionKey) {
      this.#profile = "default";
      ++this.#generation;
      ++this.#sessionEpoch;
      this.barrier.retire();
      for (const run of this.#active.values()) if (run.parent === this.#sessionKey) {
        run.parent = void 0;
        this.#abort(run, "Parent session changed.");
      }
    }
    this.#sessionKey = binding.sessionKey;
    this.#binding = binding;
    this.#reloading = false;
    const session = binding.childSession;
    if (session) this.barrier.bind(session.bridge, () => session.branch(), () => session.activePersona(), session);
    this.#deliver();
  }
  /** Observe lifecycle and batched live updates without resetting child deadlines. */
  subscribe(onChange) {
    this.#observers.add(onChange);
    return () => this.#observers.delete(onChange);
  }
  #notify() {
    clearTimeout(this.#telemetryTimer);
    this.#telemetryTimer = void 0;
    for (const f of [...this.#observers]) {
      try {
        f();
      } catch {
      }
    }
  }
  #touch(s) {
    s.updated_at = now();
    this.#activity.set(s, ++this.#activitySequence);
  }
  #deliver() {
    for (const [id, { key, details }] of this.#callbacks) {
      if (this.#reloading) return;
      this.#callbacks.delete(id);
      if (!this.#binding || this.#binding.sessionKey !== key) {
        this.barrier.delivery(id, "stale");
        continue;
      }
      try {
        void Promise.resolve(this.#binding.steer({ customType: "larva-subagent-result", details: { ...details, callback_id: id } })).then(() => this.barrier.delivery(id, "delivered"), () => this.barrier.delivery(id, "failed"));
      } catch {
        this.barrier.delivery(id, "failed");
      }
    }
  }
  #taskSyntax(id) {
    if (typeof id !== "string" || !isAbsolute4(id) || resolve6(id) !== id || id.includes("\0") || !id.endsWith(".jsonl")) bad("Expected a canonical .jsonl task_id.");
  }
  #ids(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 25 || new Set(ids).size !== ids.length) bad("Expected 1..25 distinct task_ids.");
    for (const id of ids) this.#taskSyntax(id);
  }
  async #map(profile) {
    return loadDiskModelMap(this.home, modelMapProfilePath(this.home, profile));
  }
  #recordStartupFailure(epoch, personaId2, failure) {
    const error = failure instanceof LarvaError ? failure : new LarvaError("LARVA_CHILD_START_FAILED", "Could not start the Pi child.");
    this.#failures.unshift({
      startup_id: epoch,
      persona_id: personaId2,
      status: "failed",
      phase: "startup_failed",
      updated_at: now(),
      error: toErrorEnvelope(error).error
    });
    this.#failures.length = Math.min(25, this.#failures.length);
    return error;
  }
  async spawn(input, ctx, signal = ctx.signal) {
    const epoch = mintRunEpoch(), parentSession = ctx.surface === "pi" ? ctx.sessionKey : void 0;
    const sessionEpoch = this.#sessionEpoch;
    const interrupted = Promise.withResolvers();
    interrupted.promise.catch(() => {
    });
    let owned;
    let accepted = false;
    const reason = "Subagent request was aborted.";
    const abort = signal && addAbortListener(signal, () => {
      interrupted.reject(cancelled(reason));
      if (owned && this.#active.get(owned.s.task_id) === owned) this.#abort(owned, reason);
    });
    const checkAdmission = () => {
      if (signal?.aborted) throw cancelled(reason);
      if (parentSession !== void 0 && (this.#sessionEpoch !== sessionEpoch || this.#sessionKey !== void 0 && this.#sessionKey !== parentSession)) throw cancelled("Parent session changed.");
    };
    if (ctx.surface === "pi" && this.#env.LARVA_PI_LAUNCHED === "1") this.barrier.register("larva-subagent-result", epoch);
    try {
      checkAdmission();
      keys(input, [
        "persona_id",
        "task",
        "task_id",
        "cwd",
        "no_progress_timeout_ms",
        "stall_alert_ms",
        ...ctx.surface === "mcp" ? ["parent_persona_id", "wait_for_completion"] : []
      ]);
      if (!isValidPersonaId(input.persona_id) || typeof input.task !== "string" || !input.task.trim() || input.cwd !== void 0 && (typeof input.cwd !== "string" || !isAbsolute4(input.cwd) || input.cwd.includes("\0")) || input.parent_persona_id !== void 0 && !isValidPersonaId(input.parent_persona_id) || input.wait_for_completion !== void 0 && typeof input.wait_for_completion !== "boolean") bad("Invalid spawn input.");
      if (!fitsPrompt(input.task)) bad("Task exceeds the child RPC prompt byte limit.");
      resolveWatchdogTimeouts(input, { stall_alert_ms: 0 });
      if (input.task_id !== void 0) this.#taskSyntax(input.task_id);
      const { cwd, taskId: taskId2 } = await Promise.race([workspace(this.home, input, ctx), interrupted.promise]);
      checkAdmission();
      const home = await canonicalPath(this.home);
      const root = getLarvaHomePaths(home).sessions;
      const chain = await lineage(this.#env, root, ctx.selfTaskId ?? this.#env.LARVA_PI_TASK_ID);
      const config = await loadLarvaConfig(this.home, async (p) => await entryExists(p) ? readBoundedRegularText2(p) : void 0);
      if (config.subagent.max_depth !== void 0 && chain.depth + 1 > config.subagent.max_depth) throw new LarvaError("LARVA_SPAWN_NOT_ALLOWED", "Configured maximum depth exceeded.");
      const descendant = this.#env.LARVA_PI_LAUNCHED === "1" || chain.depth > 0;
      if (ctx.surface === "pi" && !descendant && !ctx.activePersona) throw new LarvaError("LARVA_NO_ACTIVE_PERSONA", "No active persona.");
      const parent = descendant ? this.#env.LARVA_PI_INITIAL_PERSONA_ID : ctx.surface === "mcp" ? input.parent_persona_id ?? this.#env.LARVA_MCP_PARENT_PERSONA?.trim() : void 0;
      const parentSpec = parent ? await this.#personas.get(parent).catch((e) => {
        if (descendant) throw new LarvaError("LARVA_SPAWN_NOT_ALLOWED", "Launch-bound persona unavailable.");
        throw e;
      }) : void 0;
      const authority = { env: this.#env, parent_persona_id: input.parent_persona_id, resolvePersona: (id2) => id2 === parent ? parentSpec : void 0 };
      assertCanSpawnTarget(evaluateEffectiveCanSpawn(ctx.surface === "pi" ? {
        ...authority,
        surface: "pi",
        isLaunchedChild: descendant,
        activePersona: ctx.activePersona,
        rootSessionSpawn: config.subagent.root_session_spawn
      } : { ...authority, surface: "mcp", depth: chain.depth }), input.persona_id);
      const spec = await this.#personas.get(input.persona_id);
      checkAdmission();
      const id = taskId2 ?? join11(root, `${randomUUID4()}.jsonl`);
      if (chain.ancestors.includes(id) || this.#active.has(id)) throw new LarvaError("LARVA_SESSION_BUSY", "Session is already owned.");
      if (this.#closing || this.#active.size >= (config.subagent.max_active_runs ?? Infinity)) throw new LarvaError("LARVA_CHILD_START_FAILED", "Supervisor cannot admit another child.");
      const started_at = now();
      const run = {
        s: {
          task_id: id,
          run_epoch: epoch,
          cwd,
          started_at,
          updated_at: started_at,
          persona_id: spec.id,
          phase: "starting",
          status: "running",
          output_state: "pending",
          thinking: spec.thinking,
          task_preview: Array.from(input.task.replace(/\s+/g, " ").trim().slice(0, 280)).slice(0, 140).join(""),
          active_tool: null,
          live_thinking: false,
          live_assistant_preview: "",
          tool_snapshots: [],
          tool_call_count: 0
        },
        activeTools: /* @__PURE__ */ new Map(),
        accepted: Promise.withResolvers(),
        cleaned: Promise.withResolvers(),
        prompted: false,
        prompt: input.task,
        parent: parentSession,
        sessionEpoch
      };
      owned = run;
      this.#touch(run.s);
      this.#active.set(id, run);
      void this.#drive(run, spec, input, chain, config, home);
      this.#notify();
      const receipt = await run.accepted.promise;
      accepted = true;
      if (!input.wait_for_completion) return receipt;
      await this.#observe(() => isTerminal(run.s.status) && run.s.output_state !== "pending", void 0, signal);
      return terminalOutput(run.s);
    } catch (e) {
      if (accepted) throw e;
      this.barrier.delivery(epoch, "suppressed");
      if (owned) throw e;
      const failure = this.#recordStartupFailure(epoch, typeof input?.persona_id === "string" ? input.persona_id : "", e);
      this.#notify();
      throw failure;
    } finally {
      abort?.[Symbol.dispose]();
    }
  }
  async #drive(run, spec, input, chain, config, home) {
    const s = run.s, id = s.task_id;
    let lease, box, manifest;
    let accepted = false, failure;
    const check = () => {
      if (run.abort) throw run.abort;
    };
    const times = resolveWatchdogTimeouts(input, config.subagent);
    const telemetry = (frame) => {
      if (s.status !== "running" || !applyTelemetry(run, frame)) return;
      this.#touch(s);
      this.#telemetryTimer ??= setTimeout(() => this.#notify(), 50);
    };
    const progress = () => {
      if (!accepted || s.status !== "running") return;
      const phaseChanged = s.phase !== "waiting_for_child";
      clearTimers(run);
      s.phase = "waiting_for_child";
      this.#touch(s);
      if (run.parent !== void 0 && run.parent === this.#sessionKey) {
        try {
          this.barrier.relayProgress();
        } catch {
        }
      }
      if (times.stall_alert_ms) run.stall = setTimeout(() => {
        s.phase = "stall_suspected";
        this.#touch(s);
        if (run.parent !== void 0 && this.#binding?.sessionKey === run.parent && !this.#reloading) {
          const { task_id, run_epoch, persona_id, phase, status, updated_at } = s;
          try {
            void Promise.resolve(this.#binding.steer({
              customType: "larva-subagent-alert",
              details: { task_id, run_epoch, persona_id, phase, status, updated_at }
            })).catch(() => {
            });
          } catch {
          }
        }
        this.#notify();
      }, times.stall_alert_ms);
      run.watchdog = setTimeout(() => this.#abort(run, "Child exceeded its no-progress timeout."), times.no_progress_timeout_ms);
      if (phaseChanged) this.#notify();
    };
    try {
      lease = await this.#leases.acquire(id);
      if (input.task_id !== void 0) {
        const h = await readSessionHeader(this.home, id);
        if (await directory(h.cwd, "LARVA_CHILD_START_FAILED") !== s.cwd) throw new LarvaError("LARVA_SESSION_INVALID", "Session changed during admission.");
      }
      check();
      const installation = await discoverPiInstallation(this.#env);
      let generation = this.#generation;
      let route = resolveModelRoute(spec.model, await this.#map(this.#profile));
      s.model = `${route.provider}/${route.model_id}`;
      this.#notify();
      const basePiAgentDir = this.#opts.piAgentDir === void 0 ? resolveBasePiAgentDir(this.#env, void 0, this.#baseCwd) : resolve6(this.#baseCwd, this.#opts.piAgentDir);
      box = await createCapsule({
        home,
        pi_agent_dir: basePiAgentDir,
        user_home: this.#env.HOME,
        extension_sources: config.subagent.extension_sources
      });
      const parent = this.#env.LARVA_PI_CAPSULE_ROOT;
      if (parent !== void 0) {
        if (!capsuleParentPid(home, parent)) throw new LarvaError("LARVA_CHILD_START_FAILED", "Invalid parent capsule.");
        manifest = join11(parent, "descendants", `${basename9(box.root)}.json`);
        await writeMetadata(manifest, { capsule_root: box.root });
      }
      await lease.markSpawning(box.root);
      check();
      const rpc = run.rpc = launchChild({
        piScript: installation.path,
        extension: this.#opts.extension ?? fileURLToPath(new URL("./pi-extension.js", import.meta.url)),
        preload: this.#opts.preload ?? fileURLToPath(new URL("./child-rpc-preload.mjs", import.meta.url)),
        extensionSources: box.extension_sources,
        env: { ...this.#env, LARVA_PI_TASK_ID: id, LARVA_PI_MODEL_MAP_PROFILE: this.#profile },
        home,
        basePiAgentDir,
        capsule: box.root,
        agentDir: box.agent_dir,
        cwd: s.cwd,
        taskId: id,
        depth: chain.depth + 1,
        ancestors: chain.ancestors,
        persona: spec.id,
        route,
        thinking: spec.thinking
      }, progress, telemetry);
      if (rpc.pid === void 0) throw new LarvaError("LARVA_CHILD_START_FAILED", "Child did not start.");
      await lease.markRunning(rpc.pid);
      if (manifest) await writeMetadata(manifest, { capsule_root: box.root, pid: rpc.pid });
      check();
      if (input.task_id !== void 0) await rpc.resume(id);
      for (; ; ) {
        check();
        if (generation !== this.#generation) {
          generation = this.#generation;
          route = resolveModelRoute(spec.model, await this.#map(this.#profile));
          await rpc.setRoute(route, spec.thinking);
        }
        s.thinking = await rpc.verify(route, spec.thinking, id, spec.id);
        check();
        if (generation === this.#generation) break;
      }
      s.model = `${route.provider}/${route.model_id}`;
      run.prompted = true;
      await rpc.prompt(run.prompt);
      check();
      accepted = true;
      s.status = "running";
      progress();
      run.accepted.resolve({ status: "accepted", task_id: id, run_epoch: s.run_epoch, cwd: s.cwd });
      await rpc.settled;
      check();
      this.#finalize(run, "success");
      void this.#publish(run, await rpc.output());
    } catch (e) {
      failure = run.abort ?? e;
      if (accepted && !isTerminal(s.status)) {
        this.#finalize(run, failure instanceof LarvaError && failure.code === "LARVA_CHILD_CANCELLED" ? "cancelled" : "failed", failure);
        void this.#publish(run, "");
      } else if (accepted) void this.#publish(run, void 0);
    } finally {
      clearTimers(run);
      const stopping = run.rpc?.stop(!!failure || !!run.abort);
      const settleOwnership = async () => {
        try {
          const rpc = run.rpc;
          if (box && rpc && stopping && (failure || run.abort)) await terminateDescendants(home, box.root, rpc, stopping);
          if (stopping && !await stopping && !(rpc?.pid !== void 0 && pidExited(rpc.pid))) throw new Error("Unconfirmed child exit.");
          if (box && !(await inspectCapsule(home, box.root, run.rpc?.pid, "live"))?.all_exited) throw new Error("Unconfirmed capsule exit.");
          await lease?.release();
          if (box) await rm4(box.root, { recursive: true, force: true }).catch(() => {
          });
          if (manifest) await rm4(manifest, { force: true }).catch(() => {
          });
          if (run.s.cleanup_unconfirmed) run.s.cleanup_unconfirmed = false;
          this.#active.delete(id);
          return true;
        } catch {
          await lease?.markUnreconciled().catch(() => {
          });
          return false;
        }
      };
      const confirmed = await settleOwnership();
      if (!confirmed) {
        s.cleanup_unconfirmed = true;
        let checking;
        let timer;
        let interval = 250;
        const reconcile = run.reconcile = () => checking ??= settleOwnership().then((ok) => {
          clearTimeout(timer);
          if (ok) {
            run.reconcile = void 0;
            this.#touch(s);
            this.#notify();
          } else {
            interval = Math.min(interval * 2, 5e3);
            schedule();
          }
          return ok;
        }).finally(() => {
          checking = void 0;
        });
        const schedule = () => {
          timer = setTimeout(() => {
            void reconcile();
          }, interval).unref();
        };
        schedule();
      }
      run.cleaned.resolve(confirmed);
      if (!accepted) {
        clearLive(run);
        s.status = s.phase = run.abort ? "cancelled" : "failed";
        s.error = toErrorEnvelope(failure).error;
        Object.assign(s, { output_state: "inline", result_text: "" });
        this.#touch(s);
        if (!confirmed) this.#outbox.retain(s, run.prompt);
        run.accepted.reject(this.#recordStartupFailure(
          s.run_epoch,
          s.persona_id,
          failure ?? new LarvaError("LARVA_CHILD_START_FAILED", "Pi startup failed.")
        ));
      }
      this.#notify();
    }
  }
  #finalize(run, status, error) {
    clearTimers(run);
    clearLive(run);
    Object.assign(run.s, { status, phase: status }, error ? { error: toErrorEnvelope(error).error } : {});
    this.#touch(run.s);
    this.#outbox.retain(run.s, run.prompt);
    this.#notify();
  }
  async #publish(run, text2) {
    let output;
    try {
      if (text2 === void 0) throw new Error();
      output = await (this.#opts.writeOutput ?? writeOutputSnapshot)(this.home, text2);
    } catch {
      output = { output_state: "delivery_failed", output_diagnostic: { code: "LARVA_STORE_WRITE_FAILED", message: "Could not deliver child output." } };
    }
    this.#outbox.publish(run.s, output);
    this.#notify();
    if (run.parent !== void 0) {
      await run.cleaned.promise;
      if (this.#closing || run.parent === void 0 || run.sessionEpoch !== this.#sessionEpoch) {
        this.barrier.delivery(run.s.run_epoch, "stale");
        return;
      }
      this.#callbacks.set(run.s.run_epoch, { key: run.parent, details: terminalOutput(run.s, output) });
      this.#deliver();
    }
  }
  #abort(run, reason) {
    if (run.abort) return;
    run.abort = cancelled(reason);
    void run.rpc?.stop(true);
    if (isTerminal(run.s.status)) return;
    clearTimers(run);
    run.s.status = run.s.phase = "cancelling";
    this.#touch(run.s);
    this.#notify();
  }
  #lookup(id) {
    return this.#active.get(id)?.s ?? this.#outbox.lookup(id);
  }
  async #admitExactHandle(id) {
    this.#taskSyntax(id);
    try {
      await resolveCanonicalSessionPath(this.home, id);
      return true;
    } catch (error) {
      if (error instanceof LarvaError && error.code === "LARVA_SESSION_NOT_FOUND") return false;
      throw error;
    }
  }
  async pinned(taskId2, epoch) {
    await this.#admitExactHandle(taskId2);
    const s = this.#active.get(taskId2)?.s;
    return structuredClone((s?.run_epoch === epoch ? s : this.#outbox.lookup(taskId2, epoch)) ?? { task_id: taskId2, run_epoch: epoch, output_state: "evicted" });
  }
  readRunTextSlice = async (query) => {
    const unavailable = { state: "unavailable" };
    try {
      const { task_id, run_epoch, source } = query;
      const exists = await this.#admitExactHandle(task_id);
      const active = this.#active.get(task_id);
      const local = active && (run_epoch === void 0 || active.s.run_epoch === run_epoch) ? active : void 0;
      const snapshot = local?.s ?? this.#outbox.lookup(task_id, run_epoch);
      if (source === "prompt") {
        const text2 = snapshot ? local?.prompt ?? this.#outbox.prompt(snapshot.run_epoch) : run_epoch === void 0 && exists && await this.#leases.diskLockState(task_id) === "unlocked" ? await diskPrompt(this.home, task_id) : void 0;
        return text2 === void 0 ? unavailable : readRunTextSlice(text2, query);
      }
      if (source === "output") {
        if (snapshot?.output_state === "inline" && snapshot.result_text !== void 0) return readRunTextSlice(snapshot.result_text, query);
        if (snapshot?.output_state === "artifactized" && snapshot.full_output_artifact) {
          return await readArtifactSlice(this.home, snapshot.full_output_artifact.path, query);
        }
      }
    } catch {
    }
    return unavailable;
  };
  async #observe(done, deadline, signal) {
    if (signal?.aborted) throw cancelled("Subagent wait was aborted.");
    if (done() || deadline !== void 0 && deadline <= performance.now()) return;
    let timer;
    const result2 = Promise.withResolvers();
    const notify = () => {
      if (done()) result2.resolve();
    };
    const unsubscribe = this.subscribe(notify);
    const abort = signal && addAbortListener(signal, () => result2.reject(cancelled("Subagent wait was aborted.")));
    if (deadline !== void 0) timer = setTimeout(result2.resolve, Math.max(0, deadline - performance.now()));
    try {
      await result2.promise;
    } finally {
      clearTimeout(timer);
      unsubscribe();
      abort?.[Symbol.dispose]();
    }
  }
  async wait(input, surface = "mcp", signal) {
    const start = performance.now();
    keys(input, ["task_ids", "return_when", "timeout_ms"]);
    this.#ids(input.task_ids);
    const { return_when: mode = "all", timeout_ms: timeout = 1e4 } = input;
    if (!["all", "any", "first_error"].includes(mode) || !Number.isInteger(timeout) || timeout < 0 || timeout > 864e5) bad("Invalid wait condition or timeout.");
    const bound = input.task_ids.map((id) => this.#lookup(id) ?? bad("No observed run for requested task_id."));
    const matches2 = (s) => mode === "first_error" ? s.status === "failed" || s.status === "cancelled" : isTerminal(s.status);
    const satisfied = (predicate) => mode === "all" ? bound.every(predicate) : bound.some(predicate);
    const ready = () => satisfied(matches2);
    await this.#observe(() => satisfied((s) => matches2(s) && (surface === "pi" || s.output_state !== "pending")), start + timeout, signal);
    const runs = structuredClone(bound);
    const result2 = { runs, ready: ready(), timed_out: !ready() };
    return surface === "pi" ? result2 : { ...result2, terminal_outputs: Object.fromEntries(runs.filter((s) => isTerminal(s.status)).map((s) => [s.task_id, terminalOutput(s)])) };
  }
  async cancel(input) {
    keys(input, ["task_ids", "reason", "expected_run_epochs"]);
    this.#ids(input.task_ids);
    if (typeof input.reason !== "string" || !input.reason.trim() || [...input.reason].length > 500) bad("Invalid cancel reason.");
    const guards = /* @__PURE__ */ new Map();
    const expected = input.expected_run_epochs;
    if (expected !== void 0) {
      if (!Array.isArray(expected) || expected.length > 25) return bad("Invalid expected_run_epochs.");
      for (const guard of expected) {
        if (!isRecord(guard) || Object.keys(guard).length !== 2 || !Object.hasOwn(guard, "task_id") || !Object.hasOwn(guard, "run_epoch")) return bad("Invalid expected_run_epochs.");
        const { task_id, run_epoch } = guard;
        if (typeof task_id !== "string" || !input.task_ids.includes(task_id) || guards.has(task_id) || typeof run_epoch !== "string" || !run_epoch) return bad("Invalid expected_run_epochs.");
        guards.set(task_id, run_epoch);
      }
    }
    const results = await Promise.all(input.task_ids.map(async (task_id) => {
      const run = this.#active.get(task_id), s = this.#lookup(task_id);
      if (!s) return { task_id, outcome: "not_found" };
      const epoch = guards.get(task_id);
      if (!run || epoch !== void 0 && epoch !== s.run_epoch) return { task_id, outcome: "already_terminal" };
      const terminal = isTerminal(s.status);
      this.#abort(run, input.reason.trim());
      return { task_id, outcome: !await (run.reconcile?.() ?? run.cleaned.promise) ? "cleanup_unconfirmed" : terminal ? "already_terminal" : "cancelled" };
    }));
    return { results, isError: results.some((r) => r.outcome === "cleanup_unconfirmed") };
  }
  async status(input = {}) {
    keys(input, ["task_id", "scope", "limit"]);
    if (input.task_id !== void 0) {
      if (input.scope !== void 0 || input.limit !== void 0) bad("Exact status does not take scope or limit.");
      const exists = await this.#admitExactHandle(input.task_id);
      const s = this.#lookup(input.task_id);
      if (s) return { runs: [structuredClone(s)], startup_failures: [] };
      if (!exists) throw new LarvaError("LARVA_SESSION_NOT_FOUND", "Session transcript is missing.");
      return { runs: [], startup_failures: [], disk_sessions: [await readDiskSession(this.home, input.task_id, this.#leases)] };
    }
    const { scope = "recent", limit = 10 } = input;
    if (!["recent", "active", "disk"].includes(scope) || !Number.isInteger(limit) || limit < 1 || limit > 25) bad("Invalid status scope or limit.");
    if (scope === "disk") return { runs: [], startup_failures: [], disk_sessions: (await scanDiskSessions(this.home, this.#leases)).slice(0, limit) };
    const active = [...this.#active.values()].map((r) => r.s);
    const runs = scope === "active" ? active : [.../* @__PURE__ */ new Set([...active, ...this.#outbox.recent()])];
    return structuredClone({ runs: runs.sort((a, b) => (this.#activity.get(b) ?? 0) - (this.#activity.get(a) ?? 0)).slice(0, limit), startup_failures: this.#failures.slice(0, limit) });
  }
  liveCounts() {
    const counts = { running: 0, cancelling: 0 };
    for (const { s } of this.#active.values()) {
      if (s.status === "running" || s.status === "accepted") counts.running++;
      else if (s.status === "cancelling") counts.cancelling++;
    }
    return counts;
  }
  /** Capture the fleet BEFORE the parent's asynchronous route transaction, then commit only on parent success. */
  captureFleet() {
    return [...this.#active.values()].map(({ s }) => ({ task_id: s.task_id, run_epoch: s.run_epoch }));
  }
  async commitProfile(profile, fleet = this.captureFleet()) {
    if (profile !== "default" && !isValidProfileName(profile)) bad("Invalid profile name.");
    this.#profile = profile;
    ++this.#generation;
    return Promise.all(fleet.map(async ({ task_id, run_epoch }) => {
      const run = this.#active.get(task_id);
      let state;
      if (!run || run.s.run_epoch !== run_epoch || isTerminal(run.s.status)) state = "ended_during_switch";
      else {
        const fenced = !run.prompted;
        try {
          await run.accepted.promise;
          state = isTerminal(run.s.status) ? "ended_during_switch" : fenced ? "fenced_for_startup" : "in_flight_until_run_settles";
        } catch {
          state = "failed";
        }
      }
      return { task_id, run_epoch, state };
    }));
  }
  /** EOF/signals are handled by the transport. Never terminate the host from a tool call. */
  async shutdown() {
    this.#closing = true;
    const owned = [...this.#active.values()];
    for (const run of owned) this.#abort(run, "Supervisor shutdown.");
    const settled = (await Promise.all(owned.map((r) => r.reconcile?.() ?? r.cleaned.promise))).every(Boolean);
    return { settled };
  }
};

// src/activity/inspector.ts
import { createHash as createHash5 } from "node:crypto";
import { constants as constants9 } from "node:fs";
import { open as open7, stat as stat6 } from "node:fs/promises";
import { isAbsolute as isAbsolute5, normalize as normalize2 } from "node:path";

// src/core/activity-wire.ts
import { Buffer as Buffer2 } from "node:buffer";
var ACTIVITY_WIRE_MAX_BYTES = 8192;
function utf8ByteLength(text2) {
  return Buffer2.byteLength(text2, "utf8");
}

// src/activity/inspector.ts
var READ_BYTES = 64 * 1024;
var HEADER_BYTES = 1024 * 1024;
var RECORD_BYTES = 8 * 1024 * 1024;
var ACTION_CHARS = 200;
var JOIN_STEPS = 1e6;
var decoder3 = new TextDecoder("utf-8", { fatal: true });
var hash = (value) => createHash5("sha256").update(value).digest("hex");
var nonempty = (value) => typeof value === "string" && value.length > 0;
var uint = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function badInput(message) {
  throw new LarvaError("LARVA_BAD_INPUT", message);
}
function invalidSession(message) {
  throw new LarvaError("LARVA_SESSION_INVALID", message);
}
function stale() {
  return invalidSession("The recorded session snapshot changed.");
}
function timestamp(value) {
  if (typeof value !== "string" || value.length > 128) return;
  const match = /^(\d{4})-(\d\d)-(\d\d)T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) return;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return;
  const ms = Date.parse(value);
  if (Number.isFinite(ms)) return ms;
}
var queryKeys = {
  task_id: true,
  limit: true,
  cursor: true,
  tool_name: true,
  since_timestamp: true,
  until_timestamp: true,
  tool_call_id: true,
  disambiguation_index: true,
  entry_id: true,
  result_index: true,
  segment_part: true,
  offset: true,
  length: true,
  source_version: true
};
var compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
var encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token2(value, extraKeys) {
  if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    badInput("Invalid activity continuation token.");
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    badInput("Invalid activity continuation token.");
  }
  const keys2 = ["file", "end", "digest", ...extraKeys];
  if (!isRecord(data) || Object.keys(data).some((key) => !keys2.includes(key)) || !uint(data.end) || typeof data.file !== "string" || !/^[a-f0-9]{64}$/.test(data.file) || typeof data.digest !== "string" || !/^[a-f0-9]{64}$/.test(data.digest)) {
    badInput("Invalid activity continuation fields.");
  }
  return { ...data, file: data.file, end: data.end, digest: data.digest };
}
function parse2(input) {
  if (!isRecord(input) || Object.keys(input).some((key) => !Object.hasOwn(queryKeys, key))) {
    badInput("Unknown activity parameter; supply task_id, not session_path.");
  }
  const {
    task_id,
    limit = 5,
    cursor,
    tool_name,
    since_timestamp,
    until_timestamp,
    tool_call_id,
    disambiguation_index,
    entry_id,
    result_index,
    segment_part,
    offset = 0,
    length = 2e3,
    source_version
  } = input;
  if (!nonempty(task_id) || !isAbsolute5(task_id) || normalize2(task_id) !== task_id || !task_id.endsWith(".jsonl") || task_id.includes("\0") || Buffer.byteLength(task_id) > 4096) {
    badInput("task_id must be a canonical absolute .jsonl path.");
  }
  const identifier = (value) => {
    if (value === void 0) return;
    if (!nonempty(value) || Buffer.byteLength(value) > 8192) badInput("Invalid activity identifier.");
    return value;
  };
  const tool2 = identifier(tool_name), callId = identifier(tool_call_id), entryId = identifier(entry_id);
  if (!uint(limit) || limit < 1 || limit > 20 || !uint(length) || length < 1 || length > 4e3 || !uint(offset) || disambiguation_index !== void 0 && !uint(disambiguation_index) || result_index !== void 0 && !uint(result_index)) badInput("Invalid activity limit, offset, length or index.");
  if (entry_id !== void 0 && disambiguation_index !== void 0) badInput("Use only one call selector.");
  if (segment_part !== void 0 && segment_part !== "args" && segment_part !== "result") badInput("Invalid segment_part.");
  const since = timestamp(since_timestamp), until = timestamp(until_timestamp);
  if (since_timestamp !== void 0 && since === void 0 || until_timestamp !== void 0 && until === void 0 || since !== void 0 && until !== void 0 && since > until) badInput("Expected an ordered range of timezone-qualified ISO timestamps.");
  if (tool_call_id === void 0) {
    if ([entry_id, disambiguation_index, result_index, segment_part, input.offset, input.length, source_version].some((value) => value !== void 0)) badInput("Detail parameters require tool_call_id.");
  } else if ([cursor, tool_name, since, until].some((value) => value !== void 0)) {
    badInput("Exact lookup does not take listing parameters.");
  }
  const filter = hash(JSON.stringify([tool_name ?? null, since ?? null, until ?? null]));
  let page;
  if (cursor !== void 0) {
    const data = token2(cursor, ["filter", "base", "after"]);
    const { base, after } = data;
    if (data.filter !== filter || !uint(base) || base > data.end || after !== void 0 && (!Array.isArray(after) || after.length !== 3 || !after.every(uint) || after[0] >= data.end || after[1] > after[0]) || after === void 0 && base !== data.end) {
      badInput("Cursor does not match this activity query or position.");
    }
    page = {
      file: data.file,
      digest: data.digest,
      end: data.end,
      filter,
      base,
      after: after === void 0 ? void 0 : [after[0], after[1], after[2]]
    };
  }
  let version;
  if (source_version !== void 0) {
    const data = token2(source_version, ["selection"]);
    if (typeof data.selection !== "string" || !/^[a-f0-9]{64}$/.test(data.selection)) badInput("Invalid source_version selection.");
    version = { file: data.file, digest: data.digest, end: data.end, selection: data.selection };
  }
  if (offset > 0 && !version) badInput("Continued segments require source_version.");
  const part = segment_part ?? "result";
  return {
    path: task_id,
    limit,
    page,
    version,
    tool: tool2,
    since,
    until,
    filter,
    callId,
    callIndex: disambiguation_index,
    entryId,
    resultIndex: result_index,
    part,
    offset,
    length
  };
}
function record(bytes) {
  let text2;
  try {
    text2 = decoder3.decode(bytes);
  } catch {
    return { kind: "invalid_utf8", message: "Invalid UTF-8 record." };
  }
  try {
    return { value: JSON.parse(text2) };
  } catch {
    return { kind: "malformed_json", message: "Malformed JSON record." };
  }
}
function substantialDetails(details) {
  if (isRecord(details)) return Object.entries(details).some(([key, value]) => key !== "truncated" && key !== "fullOutputPath" && value != null && (key !== "truncation" || !isRecord(value) || Object.keys(value).some((key2) => key2 !== "truncated")));
  if (typeof details === "string" || Array.isArray(details)) return details.length > 0;
  return typeof details === "number" || typeof details === "boolean";
}
var detached = (value) => Buffer.from(value, "utf16le").toString("utf16le");
function resultPreview(content, details, isError) {
  let text2 = "", chars = 0, pieces = 0;
  let hasImage = false, nonText = false;
  for (const part of typeof content === "string" ? [content] : content) {
    const value = typeof part === "string" ? part : isRecord(part) && part.type === "text" ? part.text : void 0;
    if (typeof value === "string") {
      if (pieces++ && chars++ < 500) text2 += "\n";
      text2 += value.slice(0, Math.max(0, 500 - chars));
      chars += value.length;
    } else if (isRecord(part) && part.type === "image") hasImage = true;
    else if (part != null) nonText = true;
  }
  const top = isRecord(details) ? details.truncated : void 0;
  const nested = isRecord(details) && isRecord(details.truncation) ? details.truncation.truncated : void 0;
  const upstream = top === true || nested === true ? true : top === false || nested === false ? false : void 0;
  const hasDetails = substantialDetails(details);
  return {
    result: detached(text2),
    is_error: isError,
    result_truncated: chars > 500 || hasImage || nonText || hasDetails || void 0,
    has_image: hasImage || void 0,
    non_text: nonText || void 0,
    has_details: hasDetails || void 0,
    upstream_truncated: upstream
  };
}
async function readSnapshot(file, size, q, header, prior) {
  const pagingBase = q.page?.base ?? 0;
  const byId = /* @__PURE__ */ new Map();
  const entries = /* @__PURE__ */ new Map();
  const diagnostics = [];
  let diagnosticCount = 0, remainingAmbiguous = JOIN_STEPS;
  const diagnose = (kind, message, location) => {
    diagnosticCount++;
    if (diagnostics.length < 5) diagnostics.push({
      kind,
      message,
      byte_offset: location.byte_offset,
      line_byte_length: location.line_byte_length,
      line_number: location.line_number,
      content_index: location.content_index
    });
  };
  const inRange = (time) => q.since === void 0 && q.until === void 0 || time !== void 0 && (q.since === void 0 || time >= q.since) && (q.until === void 0 || time <= q.until);
  let sessionId;
  const accept = (parts2, location) => {
    const bytes = parts2.length === 1 ? parts2[0] : parts2.length > 1 ? Buffer.concat(parts2, location.line_byte_length) : void 0;
    const parsed = bytes ? record(bytes) : { kind: "oversized_record", message: "Record exceeds the inspection byte limit." };
    if (!("value" in parsed)) {
      if (location.line_number === 1) invalidSession("Invalid Pi session header.");
      diagnose(parsed.kind, parsed.message, location);
      return;
    }
    const row = parsed.value;
    if (location.line_number === 1) {
      if (!isRecord(row) || row.type !== "session" || !nonempty(row.id)) invalidSession("Pi session header lacks an ID.");
      if (row.version !== header.version || row.cwd !== header.cwd) stale();
      sessionId = row.id;
      return;
    }
    if (!isRecord(row)) {
      diagnose("malformed_record", "Record must be an object.", location);
      return;
    }
    if (nonempty(row.id)) location.entry_id = row.id;
    if (typeof row.parentId === "string" || row.parentId === null) location.parent_id = row.parentId;
    const parent = typeof location.parent_id === "string" ? entries.get(location.parent_id) : void 0;
    const id = location.entry_id;
    const unique = id !== void 0 && !entries.has(id);
    if (id !== void 0) entries.set(id, unique ? parent : void 0);
    if (row.type !== "message") return;
    const m = row.message;
    if (!isRecord(m)) {
      diagnose("malformed_record", "Missing message payload.", location);
      return;
    }
    if (m.role !== "assistant" && m.role !== "toolResult") return;
    const time = timestamp(row.timestamp);
    if (!location.entry_id || time === void 0 || row.parentId !== void 0 && location.parent_id === void 0) {
      diagnose("malformed_provenance", "Missing or invalid recorded provenance.", location);
    }
    const provenance = {
      location,
      inRange: inRange(time),
      timestamp: time === void 0 ? void 0 : String(row.timestamp),
      messageTime: typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : void 0
    };
    let digest;
    const recordDigest = (id2) => id2 === q.callId && bytes ? digest ??= createHash5("sha256").update(bytes).digest("hex") : void 0;
    if (m.role === "assistant") {
      if (!Array.isArray(m.content)) {
        diagnose("malformed_record", "Assistant content must be an array.", location);
        return;
      }
      const ancestor = { parent, calls: [] };
      for (const [contentIndex, block] of m.content.entries()) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        const callLocation = { ...location, content_index: contentIndex };
        if (!nonempty(block.id) || !nonempty(block.name) || !Object.hasOwn(block, "arguments")) {
          diagnose("malformed_record", "Tool call requires an ID, name and recorded arguments.", callLocation);
          continue;
        }
        if (q.callId !== void 0 && q.callId !== block.id) continue;
        let group = byId.get(block.id);
        if (!group) byId.set(block.id, group = { count: 0, calls: [] });
        const index = group.count++;
        if (q.tool !== void 0 && q.tool !== block.name) continue;
        const action = q.callId !== void 0 ? "" : detached(block.name.length >= ACTION_CHARS + 1 ? block.name.slice(0, ACTION_CHARS + 1) : `${block.name} ${serialize(block.arguments).slice(0, ACTION_CHARS - block.name.length)}`);
        const call = {
          ...provenance,
          location: callLocation,
          id: block.id,
          name: block.name,
          index,
          action,
          recordDigest: recordDigest(block.id),
          results: [],
          uncertain: 0
        };
        group.calls.push(call);
        ancestor.calls.push(call);
      }
      if (unique && ancestor.calls.length) entries.set(id, ancestor);
    } else if (nonempty(m.toolCallId) && nonempty(m.toolName) && (typeof m.content === "string" || Array.isArray(m.content)) && (m.isError === void 0 || typeof m.isError === "boolean")) {
      if (q.tool !== void 0 && q.tool !== m.toolName || location.byte_offset < pagingBase) return;
      const { toolCallId, toolName, content, details, isError } = m;
      const group = byId.get(toolCallId);
      if (!group?.calls.length) return;
      let remaining = JOIN_STEPS;
      const step = () => {
        if (--remaining < 0) invalidSession("Activity association exceeds the inspection work limit.");
      };
      let assigned;
      ancestry: for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
        for (const call of ancestor.calls) {
          step();
          if (call.id !== toolCallId || call.name !== toolName) continue;
          if (assigned) {
            assigned = void 0;
            break ancestry;
          }
          assigned = call;
        }
        if (assigned) break;
      }
      let result2;
      const attach = (call, uncertain) => {
        if (call.location.byte_offset < pagingBase && !call.inRange && !provenance.inRange) return;
        result2 ??= { ...provenance, preview: {}, recordDigest: recordDigest(toolCallId) };
        if (result2.preview.result === void 0 && (q.callId !== void 0 || !uncertain && (call.inRange || provenance.inRange))) {
          result2.preview = resultPreview(content, details, isError);
        }
        if (uncertain) {
          if (--remainingAmbiguous < 0) invalidSession("Activity association exceeds the inspection work limit.");
          call.uncertain++;
        }
        call.results.push({ result: result2, uncertain });
      };
      if (assigned) attach(assigned, false);
      else for (const call of group.calls) {
        step();
        if (call.name === toolName) attach(call, true);
      }
    } else diagnose("malformed_record", "Tool result requires an ID, name, content and an optional boolean error marker.", location);
  };
  let hasher = createHash5("sha256"), pendingHash;
  let pos = 0, end = 0, line = 0, pending = 0, priorVerified = !prior, sawBase = pagingBase === 0;
  let parts = [];
  while (pos < size) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_BYTES, size - pos));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, pos);
    if (bytesRead === 0) stale();
    const chunk = buffer.subarray(0, bytesRead);
    for (let from = 0; from < bytesRead; ) {
      const nl = chunk.indexOf(10, from);
      const next = nl === -1 ? bytesRead : nl + 1;
      const piece = chunk.subarray(from, next);
      pending += piece.length;
      if (nl === -1) (pendingHash ??= hasher.copy()).update(piece);
      else {
        if (pendingHash) {
          hasher = pendingHash;
          pendingHash = void 0;
        }
        hasher.update(piece);
      }
      if (pending <= (line === 0 ? HEADER_BYTES + 1 : RECORD_BYTES)) parts.push(piece);
      else parts = [];
      if (nl !== -1) {
        const location = { byte_offset: end, line_number: ++line, line_byte_length: pending };
        end = pos + next;
        if (end === pagingBase) sawBase = true;
        if (!priorVerified && prior && end >= prior.end) {
          if (end !== prior.end || hasher.copy().digest("hex") !== prior.digest) stale();
          priorVerified = true;
        }
        accept(parts, location);
        pending = 0;
        parts = [];
      }
      from = next;
    }
    pos += bytesRead;
  }
  if (!priorVerified) stale();
  if (!sawBase) badInput("Cursor base is not a recorded line boundary.");
  if (!sessionId) invalidSession("No complete Pi session header.");
  if (pending) diagnose(
    "unterminated_tail",
    "Pending tail has no terminating newline.",
    { byte_offset: end, line_number: line + 1, line_byte_length: pending }
  );
  return { sessionId, end, digest: hasher.digest("hex"), byId, diagnosticCount, diagnostics };
}
function serialize(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return invalidSession("Recorded payload exceeds the supported JSON nesting depth.");
  }
}
async function prefixDigest(file, end) {
  const buffer = Buffer.allocUnsafe(READ_BYTES), hasher = createHash5("sha256");
  for (let position = 0; position < end; ) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - position), position);
    if (!bytesRead) stale();
    hasher.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hasher.digest("hex");
}
function diagnosticsFor(snapshot) {
  const { diagnosticCount, diagnostics } = snapshot;
  return diagnosticCount ? {
    inspection_complete: false,
    diagnostics,
    total_diagnostics_count: diagnosticCount,
    diagnostics_truncated: diagnosticCount > diagnostics.length
  } : {};
}
function missingResult(snapshot) {
  return snapshot.diagnosticCount ? "incomplete" : "not_observed";
}
function piActivityResult(details) {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: "error" in details };
}
function mcpActivityResult(response) {
  const isError = "error" in response;
  const text2 = isError ? response.error.message : response.status === "ambiguous" ? `${response.total_candidates_count} matching recorded calls; select a candidate.` : "items" in response ? `${response.items.length} recorded tool calls.` : "Recorded tool call details.";
  const content = [{ type: "text", text: text2 }];
  return { content, structuredContent: response, isError };
}
function fitsActivityWire(response) {
  return [piActivityResult, mcpActivityResult].every((format) => utf8ByteLength(JSON.stringify(format(response))) <= ACTIVITY_WIRE_MAX_BYTES);
}
async function savedSegment(file, call, result2, q) {
  const target = q.part === "args" ? call : result2;
  if (!target?.recordDigest) stale();
  const { byte_offset, line_byte_length } = target.location;
  const buffer = Buffer.allocUnsafe(line_byte_length);
  for (let at = 0; at < buffer.length; ) {
    const { bytesRead } = await file.read(buffer, at, buffer.length - at, byte_offset + at);
    if (!bytesRead) stale();
    at += bytesRead;
  }
  if (createHash5("sha256").update(buffer).digest("hex") !== target.recordDigest) stale();
  const row = record(buffer);
  if (!("value" in row) || !isRecord(row.value) || !isRecord(row.value.message)) stale();
  const message = row.value.message;
  if (q.part === "result") return serialize(message);
  const block = Array.isArray(message.content) ? message.content[call.location.content_index] : void 0;
  if (!isRecord(block) || !Object.hasOwn(block, "arguments")) stale();
  return serialize(block.arguments);
}
async function detail(file, snapshot, source, q) {
  const group = q.callId === void 0 ? [] : snapshot.byId.get(q.callId)?.calls ?? [];
  const diagnostics = diagnosticsFor(snapshot);
  if (!group.length) {
    if (q.version) badInput("source_version does not match the selected call.");
    return {
      status: snapshot.diagnosticCount ? "partial" : "not_found",
      ...diagnostics,
      error: snapshot.diagnosticCount ? { code: "LARVA_SESSION_INVALID", message: "Call ID not observed; inspection was incomplete." } : { code: "LARVA_SESSION_NOT_FOUND", message: "Call ID not found in recorded session." }
    };
  }
  const matching = q.callIndex !== void 0 ? group.slice(q.callIndex, q.callIndex + 1) : q.entryId !== void 0 ? group.filter((call2) => call2.location.entry_id === q.entryId) : group;
  if (!matching.length) badInput("Call selector is out of range or does not match.");
  if (matching.length > 1) {
    if (q.version) badInput("source_version requires an exact call selection.");
    return {
      status: "ambiguous",
      candidates: matching.slice(0, 5).map((c) => ({
        index: c.index,
        ...c.location,
        call_timestamp: c.timestamp
      })),
      total_candidates_count: matching.length,
      candidates_truncated: matching.length > 5,
      selection: "Use the zero-based disambiguation_index or an entry_id that selects one call.",
      ...diagnostics
    };
  }
  const call = matching[0], count = call.results.length;
  const result2 = (q.resultIndex !== void 0 ? call.results[q.resultIndex] : !call.uncertain && count === 1 ? call.results[0] : void 0)?.result;
  if (q.resultIndex !== void 0 && !result2) badInput("result_index is out of range for recorded candidates.");
  const response = {
    status: "success",
    session_id: snapshot.sessionId,
    ...diagnostics,
    call: {
      call_id: call.id,
      tool_name: call.name,
      call_location: call.location,
      call_timestamp: call.timestamp,
      call_message_timestamp: call.messageTime,
      result_state: call.uncertain || count > 1 && !result2 ? "ambiguous" : result2 ? void 0 : missingResult(snapshot),
      result_association: call.uncertain ? "ambiguous" : void 0,
      unassociated_results_count: call.uncertain || void 0,
      result_location: result2?.location,
      result_timestamp: result2?.timestamp,
      result_message_timestamp: result2?.messageTime,
      is_error: result2?.preview.is_error,
      upstream_truncated: result2?.preview.upstream_truncated,
      result_candidates_count: count > 1 || call.uncertain ? count : void 0,
      result_candidates: count > 1 || call.uncertain ? call.results.slice(0, 5).map(({ result: r }, index) => ({
        index,
        ...r.location,
        result_timestamp: r.timestamp,
        is_error: r.preview.is_error
      })) : void 0,
      selected_result_index: q.resultIndex
    }
  };
  if (q.part === "result" && !result2) {
    if (q.version) badInput("source_version does not match an available segment.");
    return response;
  }
  const selection = hash(JSON.stringify([
    call.location.byte_offset,
    call.location.content_index,
    q.part,
    q.part === "result" ? result2?.location.byte_offset : null
  ]));
  if (q.version && q.version.selection !== selection) badInput("source_version belongs to a different call, result or segment part.");
  const text2 = await savedSegment(file, call, result2, q);
  if (q.offset > text2.length) badInput("Offset exceeds saved data length.");
  const source_version = encode({ ...source, selection });
  const segment = (length2) => {
    const next = q.offset + length2;
    return {
      part: q.part,
      encoding: "json",
      offset_units: "UTF-16 code units",
      text: text2.slice(q.offset, next),
      offset: q.offset,
      length: length2,
      total_chars: text2.length,
      has_more: next < text2.length,
      continuation_offset: next < text2.length ? next : void 0,
      source_version,
      upstream_truncated: q.part === "result" ? result2?.preview.upstream_truncated : void 0
    };
  };
  let length = Math.min(q.length, text2.length - q.offset);
  response.call.segment = segment(length);
  while (!fitsActivityWire(response) && length > 1) {
    length = Math.max(1, Math.floor(length * 0.75));
    response.call.segment = segment(length);
  }
  return response;
}
function listing(snapshot, source, q) {
  const base = q.page?.base ?? 0, after = q.page?.after;
  let eligible = 0, sawAfter = !after;
  const selected = [];
  const timeFiltered = q.since !== void 0 || q.until !== void 0;
  const offer = (call, position, count, result2, lateUncertain) => {
    if (after && compare(position, after) === 0) sawAfter = true;
    if (after && compare(position, after) <= 0) return;
    eligible++;
    if (selected.length === q.limit && compare(position, selected[q.page ? q.limit - 1 : 0].position) * (q.page ? 1 : -1) >= 0) return;
    const item = {
      call_id: call.id,
      action: call.action.slice(0, ACTION_CHARS),
      action_truncated: call.action.length > ACTION_CHARS || void 0,
      disambiguation_index: count > 1 ? call.index : void 0,
      update_type: lateUncertain === void 0 ? void 0 : "late_result",
      matched_by: timeFiltered ? call.inRange ? "call_timestamp" : "result_timestamp" : void 0
    };
    if (lateUncertain ?? call.uncertain > 0) {
      item.result_state = "ambiguous";
      item.result_association = "ambiguous";
      item.unassociated_results_count = lateUncertain ? void 0 : call.uncertain;
    } else if (!result2 && call.results.length > 1) {
      item.result_state = "ambiguous";
      item.result_candidates_count = call.results.length;
      item.result_selection = "Use exact call lookup with result_index.";
    } else if (!result2) item.result_state = missingResult(snapshot);
    else Object.assign(item, result2.preview);
    selected.push({ position, item });
    selected.sort((a, b) => compare(a.position, b.position));
    if (selected.length > q.limit) q.page ? selected.pop() : selected.shift();
  };
  for (const { calls, count } of snapshot.byId.values()) {
    for (const call of calls) {
      const start = call.location.byte_offset;
      if (start < base) {
        for (const { result: result2, uncertain } of call.results) {
          offer(call, [result2.location.byte_offset, start, call.location.content_index], count, result2, uncertain);
        }
      } else if (call.inRange || call.results.some(({ result: result2 }) => result2.inRange)) {
        offer(call, [start, start, call.location.content_index], count, call.results.length === 1 ? call.results[0].result : void 0);
      }
    }
  }
  if (!sawAfter) badInput("Cursor position does not identify a matching recorded event.");
  if (!q.page) eligible = selected.length;
  const makeResponse = () => {
    const more = eligible > selected.length;
    return {
      status: "success",
      items: selected.map((x) => x.item),
      has_more: more,
      cursor: encode({
        ...source,
        filter: q.filter,
        base: more ? base : source.end,
        after: more ? selected.at(-1)?.position : void 0
      }),
      ...diagnosticsFor(snapshot)
    };
  };
  let response = makeResponse();
  while (!fitsActivityWire(response) && selected.length > 1) {
    selected.pop();
    response = makeResponse();
  }
  if (!fitsActivityWire(response) && selected.length) {
    const item = selected[0].item;
    if (item.result !== void 0) {
      delete item.result;
      item.result_state = "present_omitted";
      item.result_truncated = true;
    }
    if (!fitsActivityWire(response) && item.action.length > 50) {
      item.action = item.action.slice(0, 50);
      item.action_truncated = true;
    }
  }
  return response;
}
async function inspectSubagentActivity(larvaHome, input) {
  try {
    const q = parse2(input);
    const target = await resolveCanonicalSessionPath(larvaHome, q.path);
    const file = await open7(target, constants9.O_RDONLY | constants9.O_NONBLOCK | constants9.O_NOFOLLOW);
    try {
      const initial = await file.stat({ bigint: true });
      if (!initial.isFile()) invalidSession("Target is not a regular session file.");
      const checkTarget = async () => {
        const current = await resolveCanonicalSessionPath(larvaHome, target).then((path) => stat6(path, { bigint: true })).catch(stale);
        if (current.dev !== initial.dev || current.ino !== initial.ino || current.size < initial.size) stale();
      };
      await checkTarget();
      const identity = hash(JSON.stringify([target, String(initial.dev), String(initial.ino)]));
      const prior = q.version ?? q.page;
      if (prior && (prior.file !== identity || BigInt(prior.end) > initial.size)) stale();
      const size = q.version?.end ?? (q.page?.after ? q.page.end : Number(initial.size));
      const header = await readSessionHeader(larvaHome, target);
      const snapshot = await readSnapshot(file, size, q, header, prior);
      const source = { file: identity, end: snapshot.end, digest: snapshot.digest };
      const response = q.callId !== void 0 ? await detail(file, snapshot, source, q) : listing(snapshot, source, q);
      if (await prefixDigest(file, snapshot.end) !== snapshot.digest) stale();
      await checkTarget();
      if (!fitsActivityWire(response)) invalidSession("Required activity metadata exceeds the wire byte limit.");
      return response;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { status: "failed", error: { code: "LARVA_SESSION_NOT_FOUND", message: "Session file not found." } };
    }
    if (isErrno(error, "ELOOP")) {
      return { status: "failed", error: { code: "LARVA_SESSION_INVALID", message: "Session path changed before opening." } };
    }
    const failure = { status: "failed", error: toErrorEnvelope(error).error };
    return fitsActivityWire(failure) ? failure : { status: "failed", error: { code: failure.error.code, message: "Activity inspection failed; diagnostic exceeds the wire byte limit." } };
  }
}

// src/ui/codex-mentions.ts
var CODEX_PERSONA_URI_TEMPLATE = "larva://personas/{persona_id}";
function personaResourceUri(id) {
  return `larva://personas/${encodeURIComponent(id)}`;
}
function parsePersonaResourceUri(uri) {
  const prefix = "larva://personas/";
  const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : void 0;
  return isValidPersonaId(id) ? id : void 0;
}
async function buildSearchMentionsOutput(personas, input) {
  const text2 = input.query.trim().toLowerCase();
  const query = /^@(?:larva(?: subagents)?|persona)$/.test(text2) ? "" : text2.replace(/^(?:@?(?:larva|persona):|@)/, "");
  const items = (await personas.list({ query, limit: input.preload ? 200 : 30 })).map((persona) => {
    const title = `@larva:${persona.id}`;
    return {
      type: "resource_link",
      uri: personaResourceUri(persona.id),
      name: persona.id,
      title,
      searchTerms: [persona.id, title, persona.description, persona.model],
      description: persona.description,
      mimeType: "text/markdown"
    };
  });
  return { items };
}
var CODEX_INITIALIZE_INSTRUCTIONS = `---
name: larva-subagent
description: Discover Larva personas and delegate self-contained work to Pi child sessions through MCP.
---

# Larva subagent routing

- An exact \`@larva:<persona_id>\`, \`@persona:<persona_id>\`, or \`larva://personas/<persona_id>\` resource (including a composer link with that title) delegates directly to \`larva_subagent\` with the supplied \`persona_id\`. Do not call \`larva_personas\` first.
- A generic \`@larva\` or \`@Larva Subagents\` mention without a persona ID calls \`larva_personas\` first. Select a returned ID; do not invent one.
- For ordinary work without a Larva or Persona request, use Codex's native tools. Do not mix Larva \`task_id\` handles with Codex agent IDs.

## Choose the workspace

For a fresh spawn, omit \`cwd\` only when the host supports \`roots/list\` and returns exactly one root (\`roots.length === 1\`) whose URI is a local \`file://\` directory that exists. For zero roots, multiple roots (even if only one exists), an unusable root, or unsupported \`roots/list\`, pass an explicitly authorized absolute \`cwd\`; ask the user if it is ambiguous. For resume, use the exact returned \`task_id\` and omit \`cwd\` so Larva uses the recorded workspace.

## Delegate and observe

Give \`larva_subagent\` the exact \`persona_id\`, a self-contained task, scope, and completion checks. Use \`wait_for_completion: true\` to receive one run's terminal output directly, or \`wait_for_completion: false\` to receive an accepted receipt before waiting. Keep exact \`.jsonl\` handles and retain responsibility for integrating results. Reconcile any uncertain effects before a user-authorized resume.

Use \`larva_subagent_wait\` with \`return_when: "any"\` and a bounded \`timeout_ms\` to collect ready runs. A timed-out checkpoint is not completion; inspect ready runs and their terminal outputs. Use unified \`larva_subagent_status\` with an exact \`task_id\` or an \`active\`, \`recent\`, or \`disk\` scope. Use \`larva_subagent_activity\` with \`task_id\` to inspect recorded tool activity, not to infer live state. To cancel, use \`larva_subagent_cancel\` with \`task_ids\` and \`reason\`; inspect each outcome rather than assuming cleanup succeeded.

For example, using an exact handle returned by \`larva_subagent\`:

\`\`\`json
[
  {"name":"larva_subagent_wait","arguments":{"task_ids":["/example/sessions/child.jsonl"],"return_when":"any","timeout_ms":60000}},
  {"name":"larva_subagent_status","arguments":{"task_id":"/example/sessions/child.jsonl"}},
  {"name":"larva_subagent_activity","arguments":{"task_id":"/example/sessions/child.jsonl"}},
  {"name":"larva_subagent_cancel","arguments":{"task_ids":["/example/sessions/child.jsonl"],"reason":"The user requested cancellation."}}
]
\`\`\`
`;

// src/ui/codex-panel-html.ts
var CODEX_PANEL_URI = "ui://larva-pi-subagent/panel-v4";
var CODEX_PANEL_DISPLAY_MODES = ["fullscreen"];
function renderCodexPanelHtml(version) {
  return renderCodexAppHtml("panel", CODEX_PANEL_DISPLAY_MODES, version);
}
function renderCodexAppHtml(surface, modes, version = "source") {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>Larva Subagents</title><style>${styles}</style></head>
<body><div id="app"></div><script>(${app})(${JSON.stringify(surface)},${JSON.stringify(modes)},${JSON.stringify(version)});</script></body></html>`;
}
var styles = `
:root {
  color-scheme: light dark;
  --background: var(--color-background-primary, light-dark(#ffffff, #181818));
  --foreground: var(--color-text-primary, light-dark(#1a1c1f, #ffffff));
  --secondary: var(--color-background-secondary, light-dark(rgba(255,255,255,.96), rgba(54,54,54,.96)));
  --tertiary: var(--color-background-tertiary, color-mix(in srgb, var(--foreground) 4%, var(--background)));
  --card: color-mix(in srgb, var(--foreground) 5%, var(--background));
  --muted: color-mix(in srgb, var(--foreground) 8%, transparent);
  --muted-foreground: var(--color-text-secondary, light-dark(rgba(26,28,31,.55), rgba(255,255,255,.55)));
  --border: var(--color-border-secondary, light-dark(rgba(26,28,31,.09), rgba(255,255,255,.09)));
  --input: var(--color-border-primary, light-dark(rgba(26,28,31,.13), rgba(255,255,255,.13)));
  --primary: var(--color-text-info, light-dark(#339cff, #83c3ff));
  --accent: var(--color-background-info, color-mix(in srgb, var(--primary) 14%, transparent));
  --success: var(--color-text-success, light-dark(#16a34a, #4ade80));
  --success-bg: var(--color-background-success, color-mix(in srgb, var(--success) 14%, transparent));
  --warning: var(--color-text-warning, light-dark(#d97706, #fbbf24));
  --warning-bg: var(--color-background-warning, color-mix(in srgb, var(--warning) 14%, transparent));
  --danger: var(--color-text-danger, light-dark(#dc2626, #f87171));
  --danger-bg: var(--color-background-danger, color-mix(in srgb, var(--danger) 14%, transparent));
  --ring: var(--color-ring-primary, var(--primary));
  --radius-sm: var(--border-radius-sm, 6px);
  --radius-md: var(--border-radius-md, 8px);
  --radius-lg: var(--border-radius-lg, 12px);
  --app-font-sans: var(--font-sans, -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif);
  --app-font-mono: var(--font-mono, ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace);
  font: 13px/1.5 var(--app-font-sans);
  color: var(--foreground);
  background: var(--background);
}
[data-theme=light] { color-scheme: light }
[data-theme=dark] { color-scheme: dark }
* { box-sizing: border-box }
body { margin: 0 }
/* Keep inline height intrinsic even after the host resizes the iframe. */
#app { padding: calc(12px + var(--safe-top, 0px)) calc(12px + var(--safe-right, 0px)) calc(12px + var(--safe-bottom, 0px)) calc(12px + var(--safe-left, 0px)); overflow-wrap: anywhere }
[data-mode=fullscreen] #app { display: flex; flex-direction: column; height: 100dvh }
button { font: inherit; color: inherit; cursor: pointer; background: transparent; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 5px 9px; min-height: 30px }
button:hover { background: var(--muted) }
button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px }
button:disabled { opacity: .5; cursor: wait }
button[aria-pressed=true] { background: var(--accent); border-color: var(--primary) }
.toolbar, .row, .controls, .tabs { display: flex; align-items: center; gap: 8px; flex-wrap: wrap }
.toolbar { padding-bottom: 10px }
.toolbar > :is(h1, strong) { margin-inline-end: auto }
.toolbar > strong, .run-card strong, .tool-row strong, .preview { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.model, .badge { border-radius: 999px; background: var(--muted); padding: 1px 6px; font-size: 11px }
.elapsed { font-variant-numeric: tabular-nums; white-space: nowrap; margin-inline-start: auto; color: var(--muted-foreground) }
.summary, .muted { color: var(--muted-foreground) }
.status { display: inline-flex; flex: none; color: var(--muted-foreground) }
.status svg { display: block }
.status[data-status=running], .status[data-status=accepted] { color: var(--primary) }
.status[data-status=running] { animation: pulse 2s ease-in-out infinite }
@keyframes pulse { 50% { opacity: .45 } }
@media (prefers-reduced-motion: reduce) { .status[data-status=running] { animation: none } }
.status[data-status=success] { color: var(--success) }
.status[data-status=failed], .error, .cancel { color: var(--danger) }
.status[data-status=cancelled], .status[data-status=stall_suspected], .warning { color: var(--warning) }
.workbench { display: grid; grid-template-columns: minmax(220px, 30%) minmax(0, 1fr); flex: 1; min-height: 280px; border-top: 1px solid var(--border) }
.run-list { min-width: 0; overflow: auto; padding: 12px 12px 12px 0; border-inline-end: 1px solid var(--border) }
.run-card { display: block; width: 100%; text-align: start; padding: 10px; margin-bottom: 6px; background: var(--tertiary); border-radius: var(--radius-md); overflow: hidden }
.run-card .row { flex-wrap: nowrap }
.run-card .preview { display: block; color: var(--muted-foreground); margin-top: 4px }
.inspector { overflow: auto; padding: 16px; min-width: 0 }
.detail-header { margin-bottom: 16px }
h1, h2 { font-size: 17px; margin: 0 }
h3 { font-size: 12px; margin: 14px 0 8px }
h4 { font-size: 11px; color: var(--muted-foreground); margin: 10px 0 4px }
p { margin: 0 0 8px }
.tabs { border-bottom: 1px solid var(--border); padding-bottom: 8px; position: sticky; top: 0; background: var(--background); z-index: 1; flex-wrap: nowrap }
.tabs button { flex: 1 1 0; min-width: 0 }
.tab-body { padding-top: 12px; min-width: 0 }
code, pre { font: 12px/1.6 var(--app-font-mono) }
pre { white-space: pre-wrap; overflow-wrap: anywhere; overflow: auto; margin: 6px 0 12px }
.stream, .result { padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--tertiary) }
.stream { max-height: 160px }
.result { max-height: 55dvh }
.activity { color: var(--primary); background: var(--accent); border-radius: var(--radius-sm); padding: 8px }
.drawer { margin-top: 12px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--secondary); box-shadow: 0 2px 6px var(--muted); max-height: 340px; overflow-y: auto }
[data-mode=inline] .result { max-height: 220px }
.telemetry { list-style: none; padding: 0; margin: 0 }
.telemetry li { border: 1px solid var(--border); border-radius: var(--radius-md); margin: 6px 0 }
.tool-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: start; border: 0 }
.tool-row .preview { flex: 1; color: var(--muted-foreground) }
.tool-content { padding: 0 12px 12px }
.tool-content pre { max-height: 260px }
.metadata { display: grid; grid-template-columns: max-content minmax(0, 1fr) max-content minmax(0, 1fr); gap: 4px 10px; font-size: 11px }
.metadata dt { color: var(--muted-foreground) }
.metadata dd { margin: 0; overflow-wrap: anywhere }
.metadata .session-label { grid-column: 1 }
.metadata .session-value { grid-column: 2 / -1 }
.section-card { border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--tertiary); padding: 10px; margin-bottom: 10px }
.section-header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap }
.section-header h3 { margin: 0 auto 0 0 }
.section-header button { font-size: 11px; min-height: 26px; padding: 3px 7px }
.prompt-box { max-height: 110px; overflow: auto; padding: 8px; background: var(--background); border: 1px solid var(--border); border-radius: var(--radius-sm) }
.prompt-box[data-expanded=true] { max-height: none }
.compact-list, .switcher { max-height: 180px; overflow: auto; padding: 3px }
.compact-list .run-card { display: flex; gap: 12px; padding: 6px }
.compact-list .run-card > .row { flex: 0 1 auto; min-width: 0 }
.compact-list .run-card:has(> .preview) > .row { max-inline-size: 50% }
.compact-list .run-card > .preview { flex: 1 }
.switcher { display: flex; gap: 6px; margin-top: 8px }
.switcher .run-card { flex: 0 0 180px }
.notice { padding: 8px 10px; background: var(--muted); border-inline-start: 3px solid }
.notice.warning { background: var(--warning-bg) }
.notice.error { background: var(--danger-bg) }
@media (max-width: 679px) {
  .workbench { display: flex; flex-direction: column }
  .run-list { flex: 0 0 auto; max-height: 148px; overflow-y: auto; border-inline-end: 0; border-bottom: 1px solid var(--border); padding: 8px 0 }
  .inspector { flex: 1; min-height: 0; padding: 12px 0 }
  .toolbar { gap: 6px }
}
`;
var app = String.raw`function (surface, modes, version) {
  const panel = surface === 'panel';
  const root = document.getElementById('app');
  const terminal = new Set(['success', 'failed', 'cancelled']);
  const active = run => run.status === 'accepted' || run.status === 'running';
  const scopes = ['active', 'recent', 'disk'];
  const pair = row => typeof row?.task_id === 'string' && row.task_id.length > 0 &&
    typeof row.run_epoch === 'string' && row.run_epoch.length > 0;
  const key = row => JSON.stringify([row.task_id, row.run_epoch]);
  const phase = run => ({ starting: 'Starting', waiting_for_child: 'Working', stall_suspected: 'Stall suspected',
    cancelling: 'Cancelling', success: 'Completed', failed: 'Failed', cancelled: 'Cancelled' })[run.phase] ?? run.status;
  const same = (a, b) => pair(a) && pair(b) && a.task_id === b.task_id && a.run_epoch === b.run_epoch;
  const captured = new Map();
  const cancelling = new Set();
  const detailsOpen = new Set();
  const expandedPrompts = new Set();
  const collapsedTools = new Map();
  const requests = new Map();
  const cancelNotices = new Map();
  const tabs = ['All', 'Timeline', 'Result', 'Task & Session'];
  let tab = tabs[0], doneOnly = false, activity, textRead;
  let sequence = 0, view = 0, renderVersion = 0, pollTimer, clockTimer, poll, displayRequest, mode = modes[0], availableModes = modes;
  let connection = 'connecting';
  let target = { kind: 'pending' };
  let toolInput, initialResult, waitOutcome, renderDeferred = false;
  let rows = [], failures = [], selected, loading = true, readError;

  const visible = () => document.visibilityState !== 'hidden';
  const observing = () => connection === 'ready' && visible();
  const post = message => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const notify = (method, params = {}) => post({ method, params });

  function rpc(method, params, kind = 'observer') {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error('The host did not respond.'));
        if (kind === 'initialize') disconnect();
      }, 15000);
      requests.set(id, { resolve, reject, timer, kind });
      try { post({ id, method, params }); }
      catch (error) { disconnect(); }
    });
  }

  function retireRequests(predicate) {
    for (const [id, request] of requests) {
      if (!predicate(request.kind)) continue;
      requests.delete(id);
      clearTimeout(request.timer);
      request.reject(new Error('View closed.'));
    }
  }

  function clearActivity() {
    if (!activity) return;
    activity = undefined;
    retireRequests(kind => kind === 'activity');
  }

  function stopObserving() {
    view++;
    clearTimeout(pollTimer);
    clearInterval(clockTimer);
    clockTimer = undefined;
    poll = undefined;
    clearActivity();
    clearTextRead();
    retireRequests(kind => kind === 'observer');
  }

  function disconnect() {
    if (connection === 'closed' || connection === 'lost') return;
    connection = 'lost';
    finishInvocation();
    stopObserving();
    retireRequests(() => true);
    observer.disconnect();
    render();
  }

  function applyContext(context) {
    if (Array.isArray(context?.availableDisplayModes)) availableModes = modes.filter(candidate => context.availableDisplayModes.includes(candidate));
    if (availableModes.includes(context?.displayMode)) mode = context.displayMode;
    else if (!availableModes.includes(mode) && availableModes.length) mode = availableModes[0];
    const html = document.documentElement;
    if (context?.theme === 'light' || context?.theme === 'dark') html.dataset.theme = context.theme;
    for (const [name, value] of Object.entries(context?.styles?.variables ?? {})) {
      if (name.startsWith('--') && typeof value === 'string') html.style.setProperty(name, value);
    }
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const size = context?.safeAreaInsets?.[side];
      if (Number.isFinite(size) && size >= 0) html.style.setProperty('--safe-' + side, size + 'px');
    }
    render();
  }

  function queryFor(input, fallbackScope) {
    if (typeof input.task_id === 'string' && input.task_id) return { task_id: input.task_id };
    return {
      ...(scopes.includes(input.scope) ? { scope: input.scope } : fallbackScope ? { scope: fallbackScope } : {}),
      ...(Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 25 ? { limit: input.limit } : {}),
    };
  }

  function invocationFor(args) {
    if ('task_ids' in args) return { kind: 'wait', taskIds: Array.isArray(args.task_ids) ? args.task_ids.slice(0, 25) : [] };
    if ('task' in args || 'persona_id' in args) return { kind: 'spawn', personaId: typeof args.persona_id === 'string' ? args.persona_id : undefined };
    return { kind: 'status', query: queryFor(args) };
  }

  const dataOf = result => result?.structuredContent ?? result?.details ?? result;
  const errorOf = result => dataOf(result)?.error?.message ?? result?.content?.find?.(item => item.type === 'text')?.text;
  const tool = (name, args, kind) => rpc('tools/call', { name, arguments: args }, kind);

  function terminalOutput(run, outputs) {
    const output = outputs && Object.hasOwn(outputs, run.task_id) ? outputs[run.task_id] : undefined;
    if (!same(run, output) || !terminal.has(output.status)) return run;
    // Do not carry the run's stale preview/artifact into a different output state.
    const { output_state, result_text, result_preview, full_output_artifact, output_diagnostic, ...metadata } = run;
    return { ...metadata, ...output };
  }

  function isCaptured(run) {
    return terminal.has(run.status) && ['inline', 'artifactized', 'delivery_failed', 'evicted'].includes(run.output_state);
  }

  function acceptSnapshot(data, pinRefresh = false) {
    const runs = (Array.isArray(data?.runs) ? data.runs : []).filter(pair);
    if (target.kind === 'pinned') {
      rows = Array.from(target.pairs, ([id, epoch]) => {
        const run = runs.find(row => row.task_id === id && row.run_epoch === epoch);
        if (run) {
          const current = terminalOutput(run, data.terminal_outputs);
          if (isCaptured(current)) captured.set(id, current);
          const saved = captured.get(id);
          return { kind: 'run', run: saved ? { ...saved, ...current, ...(!isCaptured(current) && {
            output_state: saved.output_state, result_text: saved.result_text, result_preview: saved.result_preview,
            full_output_artifact: saved.full_output_artifact, output_diagnostic: saved.output_diagnostic,
          }) } : current };
        }
        const saved = captured.get(id);
        const previous = rows.find(row => row.run?.task_id === id && row.run?.run_epoch === epoch)?.run ?? saved;
        const error = data.row_errors?.find(item => item.task_id === id && item.run_epoch === epoch)?.error;
        if (error) return { kind: 'fault', run: previous ?? { task_id: id, run_epoch: epoch }, error };
        return saved ? { kind: 'run', run: saved }
          : { kind: pinRefresh ? 'expired' : 'run', run: { task_id: id, run_epoch: epoch, output_state: 'pending' } };
      });
      return;
    }
    if (target.kind !== 'latest') return;
    const query = target.query;
    failures = query.task_id || query.scope === 'disk' ? []
      : (Array.isArray(data?.startup_failures) ? data.startup_failures.slice(0, 25) : []);
    const live = runs.filter(run => !query.task_id || query.task_id === run.task_id)
      .map(run => terminalOutput(run, data.terminal_outputs));
    if (query.scope === 'disk' || (query.task_id && !live.length)) {
      const disk = Array.isArray(data?.disk_sessions) ? data.disk_sessions.slice(0, 25) : [];
      rows = disk.filter(row => typeof row?.task_id === 'string' && typeof row.cwd === 'string' &&
        (!query.task_id || query.task_id === row.task_id)).map(disk => ({
        kind: 'disk', disk, run: disk.lock_state === 'active_local' ? live.find(run => run.task_id === disk.task_id) : undefined,
      }));
    } else {
      rows = live.filter(run => query.scope !== 'active' || !terminal.has(run.status) || run.cleanup_unconfirmed).map(run => ({ kind: 'run', run }));
    }
  }

  function applyInvocation() {
    if (target.kind !== 'pending' || !toolInput || initialResult === undefined) return;
    const data = dataOf(initialResult);
    const runs = Array.isArray(data?.runs) ? data.runs.slice(0, 25) : [];
    // The app notifications carry arguments and a result, not necessarily the
    // tool name. Use the disjoint spawn/wait receipt shapes, never input IDs
    // alone, as the authority for binding an epoch.
    const waitResult = toolInput.kind === 'wait' && !initialResult.isError &&
      typeof data?.ready === 'boolean' && typeof data.timed_out === 'boolean';
    if (waitResult) waitOutcome = [data.ready ? 'Wait ready' : 'Wait not ready', data.timed_out && 'Timed out'].filter(Boolean).join(' · ');
    let snapshots = [];
    if (toolInput.kind === 'spawn' && pair(data) &&
        (terminal.has(data.status) || (!initialResult.isError && data.status === 'accepted'))) {
      snapshots = [{ persona_id: toolInput.personaId, phase: data.status === 'accepted' ? 'starting' : data.status,
        output_state: 'pending', ...data }];
    } else if (waitResult) {
      snapshots = runs.filter(row => toolInput.taskIds.includes(row?.task_id));
    }
    const pairs = new Map(snapshots.filter(pair).map(row => [row.task_id, row.run_epoch]));
    if (pairs.size) {
      target = { kind: 'pinned', pairs };
      acceptSnapshot({ runs: snapshots, terminal_outputs: data.terminal_outputs });
    } else if (initialResult.isError || data?.error || waitResult) {
      const message = errorOf(initialResult) ?? (waitResult ? 'No run snapshot was returned for this wait.' : 'The tool call was rejected.');
      target = { kind: 'rejected', message };
    } else if (toolInput.kind === 'status' && Array.isArray(data?.runs) && Array.isArray(data.startup_failures)) {
      target = { kind: 'latest', query: toolInput.query };
      acceptSnapshot(data);
    } else {
      return;
    }
    finishInvocation();
    loading = false;
    render();
    void refresh();
  }

  function finishInvocation() {
    toolInput = undefined;
    initialResult = undefined;
  }

  async function refresh() {
    if (!observing() || poll || (target.kind !== 'pinned' && target.kind !== 'latest')) return;
    clearTimeout(pollTimer);
    const ticket = poll = { stale: false };
    const args = target.kind === 'pinned' ? { run_epochs: Array.from(target.pairs, ([task_id, run_epoch]) => ({ task_id, run_epoch })) } : target.query;
    try {
      const read = async query => {
        const response = await tool('larva_subagent_panel', query);
        if (response?.isError) throw new Error(errorOf(response) ?? 'Could not refresh runs.');
        const data = dataOf(response);
        if (!Array.isArray(data?.runs)) throw new Error('Invalid run snapshot from the host.');
        return data;
      };
      const grouped = target.kind === 'latest' && !args.task_id && (!args.scope || args.scope === 'recent') && mode === 'fullscreen';
      if (grouped) {
        const results = await Promise.allSettled([read({ ...args, scope: 'active', limit: args.limit ?? 25 }), read({ ...args, limit: args.limit ?? 25 })]);
        if (poll !== ticket || ticket.stale) return;
        const [live, recent] = results;
        const combined = new Map();
        // Without a fresh side, preserve its existing rows rather than reporting their disappearance.
        for (const [side, outcome] of results.entries()) {
          const source = outcome.status === 'fulfilled' ? outcome.value.runs
            : rows.filter(row => row.kind === 'run' && (side === 0 ? !terminal.has(row.run.status) : terminal.has(row.run.status))).map(row => row.run);
          for (const run of source) if (pair(run)) {
            const id = key(run), previous = combined.get(id);
            if (!previous || previous.updated_at < run.updated_at) combined.set(id, run);
          }
        }
        acceptSnapshot({ runs: [...combined.values()], startup_failures: recent.value?.startup_failures ?? live.value?.startup_failures ?? failures });
        readError = results.flatMap((outcome, index) => outcome.status === 'rejected' ? [(index ? 'Done: ' : 'Active: ') + outcome.reason.message] : []).join(' ') || undefined;
      } else {
        const data = await read(args);
        if (poll !== ticket || ticket.stale) return;
        acceptSnapshot(data, true);
        readError = undefined;
      }
    } catch (error) {
      if (poll === ticket && !ticket.stale) readError = error.message;
    } finally {
      if (poll === ticket) {
        poll = undefined;
        if (ticket.stale) void refresh();
        else {
          loading = false;
          render(true);
          if (target.kind === 'latest' || readError || rows.some(row => row.kind === 'fault' ||
              row.kind === 'run' && (!isCaptured(row.run) || row.run.cleanup_unconfirmed))) {
            pollTimer = setTimeout(refresh, 1000);
          }
        }
      }
    }
  }

  function reopen() {
    render();
    void refresh();
  }

  function setQuery(query, showDone = false) {
    doneOnly = showDone;
    stopObserving();
    target = { kind: 'latest', query };
    rows = []; failures = []; selected = undefined; readError = undefined;
    loading = true;
    reopen();
  }

  async function changeMode() {
    const requested = mode === 'inline' ? 'fullscreen' : 'inline';
    if (!observing() || displayRequest || !availableModes.includes(requested)) return;
    const ticket = displayRequest = {};
    const token = view;
    render();
    try {
      const result = await rpc('ui/request-display-mode', { mode: requested });
      if (token !== view || !observing()) return;
      applyContext({ displayMode: result?.mode });
      void refresh();
    } catch (error) {
      if (token === view && observing()) readError = error.message;
    } finally {
      if (displayRequest === ticket) { displayRequest = undefined; render(); }
    }
  }

  async function cancel(run) {
    const id = key(run);
    const owns = row => row.kind === 'run' && same(row.run, run) && (active(row.run) || row.run.cleanup_unconfirmed);
    if (!observing() || loading || cancelling.has(id) || !rows.some(owns)) return;
    const token = view;
    cancelling.add(id);
    cancelNotices.delete(id);
    render();
    try {
      const response = await tool('larva_subagent_cancel', {
        task_ids: [run.task_id], reason: 'Cancelled from Larva Subagents',
        expected_run_epochs: [{ task_id: run.task_id, run_epoch: run.run_epoch }],
      }, 'cancel');
      if (token !== view || !observing()) return;
      const item = dataOf(response)?.results?.find?.(result => result?.task_id === run.task_id);
      switch (item?.outcome) {
        case 'cancelled':
        case 'already_terminal': break;
        case 'cleanup_unconfirmed':
          cancelNotices.set(id, { text: 'Cancellation cleanup could not be confirmed.', style: 'warning' }); break;
        case 'not_found':
          cancelNotices.set(id, { text: 'Run not found for cancellation. No newer run was targeted.', style: 'error' }); break;
        default: throw new Error(errorOf(response) ?? 'Cancellation outcome unavailable.');
      }
      if (item.outcome !== 'cleanup_unconfirmed') {
        loading = true;
        if (poll) poll.stale = true;
      }
    } catch (error) {
      if (token === view && observing()) cancelNotices.set(id, { text: error.message, style: 'error' });
    } finally {
      cancelling.delete(id);
      if (token === view && observing()) {
        render();
        void refresh();
      }
    }
  }

  function element(tag, text, parent = root) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    parent.append(node);
    return node;
  }

  function button(name, action, parent, options = {}) {
    const node = element('button', name, parent);
    const version = renderVersion;
    const current = () => version === renderVersion && visible() && connection !== 'closed';
    node.type = 'button';
    node.onclick = () => { if (current() && !node.disabled) action(current); };
    node.disabled = options.disabled ?? false;
    node.dataset.focusKey = options.key ?? name;
    if (options.pressed !== undefined) node.setAttribute('aria-pressed', String(options.pressed));
    if (options.expanded !== undefined) node.setAttribute('aria-expanded', String(options.expanded));
    return node;
  }

  function copyButton(label, text, parent, id) {
    if (typeof text !== 'string' || !text) return;
    const feedback = element('span', '', parent);
    feedback.setAttribute('role', 'status');
    button(label, async current => {
      let copied = false;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          copied = true;
        }
      } catch { /* A sandbox may deny Clipboard API access. */ }
      if (!current()) return;
      if (!copied) {
        const focus = document.activeElement;
        const field = element('textarea', undefined, parent);
        field.value = text;
        field.readOnly = true;
        field.style.position = 'fixed';
        field.style.opacity = '0';
        try {
          field.select();
          copied = document.execCommand?.('copy') === true;
        } catch { /* Fall back to user selection. */ }
        finally { field.remove(); focus?.focus({ preventScroll: true }); }
      }
      feedback.textContent = copied ? 'Copied.' : 'Copy unavailable. Select the text to copy it manually.';
    }, parent, { key: label + ':' + id });
  }

  function notice(text, style, parent = root) {
    const node = element('p', text, parent);
    node.className = 'notice ' + style;
    node.setAttribute('role', style === 'error' ? 'alert' : 'status');
  }

  function pathLine(label, path, parent) {
    if (typeof path !== 'string' || !path) return;
    const line = element('p', label + ': ', parent);
    element('code', path, line);
  }

  function section(title, parent) {
    const card = element('section', undefined, parent);
    card.className = 'section-card';
    const heading = element('div', undefined, card);
    heading.className = 'section-header';
    element('h3', title, heading);
    return { card, heading };
  }

  function clearTextRead() {
    textRead = undefined;
    retireRequests(kind => kind === 'slice');
  }

  async function readText(run, source, offset) {
    if (!observing()) return;
    const previous = offset !== undefined ? textRead : undefined;
    clearTextRead();
    const request = textRead = { runKey: key(run), source, state: 'loading' };
    render();
    try {
      let text = '';
      do {
        const response = await tool('larva_subagent_panel', { slice: {
          task_id: run.task_id, ...(run.run_epoch && { run_epoch: run.run_epoch }), source,
          offset: offset ?? 0,
        } }, 'slice');
        if (textRead !== request || !observing()) return;
        const page = dataOf(response)?.slice;
        if (response?.isError) throw new Error(errorOf(response) ?? 'Could not read text.');
        if (page?.state !== 'ok') throw new Error('Full ' + source + ' is unavailable.');
        if (page.offset !== (offset ?? 0) || typeof page.text !== 'string' ||
            (page.continuation_offset !== undefined && (!Number.isSafeInteger(page.continuation_offset) || page.continuation_offset <= page.offset))) {
          throw new Error('Invalid text page from host.');
        }
        text += page.text;
        offset = page.continuation_offset;
      } while (source === 'prompt' && offset !== undefined);
      Object.assign(request, { state: 'ready', text, next: offset, start: previous?.next ?? 0 });
    } catch (error) {
      if (textRead !== request || !observing()) return;
      Object.assign(request, { state: 'error', message: error.message });
    }
    render(true);
  }

  function textReader(run, source, parent) {
    const current = textRead?.source === source && textRead.runKey === key(run) ? textRead : undefined;
    const label = source === 'prompt' ? 'Load full prompt' : 'Read full output';
    button(label, () => void readText(run, source), parent, { disabled: !observing() || current?.state === 'loading' });
    if (current?.state === 'loading') notice('Reading ' + source + '…', '', parent);
    if (current?.state === 'error') notice(current.message, 'error', parent);
    if (current?.state !== 'ready') return;
    const page = element('pre', current.text, parent);
    page.className = source === 'prompt' ? 'prompt-box' : 'result';
    page.dataset.scrollKey = 'full:' + source + ':' + key(run);
    if (source === 'prompt') copyButton('Copy full prompt', current.text, parent, key(run));
    else {
      copyButton('Copy output page', current.text, parent, key(run));
      if (current.next !== undefined) button('Next output page', () => void readText(run, source, current.next), parent, { disabled: !observing() });
      if (current.start) button('First output page', () => void readText(run, source), parent, { disabled: !observing() });
    }
  }

  function output(run, container) {
    const { card: parent, heading } = section('Result', container);
    if (run.error?.message) notice(run.error.message, 'error', parent);
    const artifact = run.full_output_artifact?.path;
    const text = run.result_text ?? run.result_preview;
    const preview = run.result_preview ?? run.result_text;
    const show = value => {
      const pre = element('pre', value, parent);
      pre.className = 'result';
      pre.dataset.scrollKey = 'output:' + key(run);
    };
    switch (run.output_state) {
      case 'inline':
        show(text ?? '');
        copyButton('Copy output', text, heading, key(run));
        break;
      case 'artifactized':
        if (preview) show(preview);
        copyButton('Copy output preview', preview, heading, key(run));
        pathLine(artifact ? 'Full output artifact' : 'Recorded transcript', artifact ?? run.task_id, parent);
        textReader(run, 'output', parent);
        break;
      case 'delivery_failed':
        notice((run.status === 'success' ? 'Execution succeeded, but output delivery failed.' : 'Output delivery failed.') +
          (run.output_diagnostic?.message ? ' ' + run.output_diagnostic.message : ''), 'warning', parent);
        if (run.result_preview) show(run.result_preview);
        copyButton('Copy output preview', run.result_preview, heading, key(run));
        pathLine('Recorded transcript', run.task_id, parent);
        break;
      case 'evicted':
        notice('Output evicted from the live snapshot.', 'warning', parent);
        pathLine(artifact ? 'Full output artifact' : 'Recorded transcript', artifact ?? run.task_id, parent);
        break;
      default: notice('Output pending…', '', parent);
    }
  }

  async function inspect(run, callId, part, selection = {}) {
    if (!observing()) return;
    clearActivity();
    const request = activity = { runKey: key(run), callId, part, selection, state: 'loading' };
    render();
    try {
      const result = await tool('larva_subagent_activity', {
        task_id: run.task_id, tool_call_id: callId, segment_part: part, ...selection,
      }, 'activity');
      if (activity !== request || !observing()) return;
      const data = dataOf(result);
      const segment = data?.call?.segment;
      if (result?.isError || data?.error) throw new Error(errorOf(result) ?? 'Recorded activity unavailable.');
      if (data?.status === 'ambiguous') {
        Object.assign(request, { state: 'choose', candidates: data.candidates, coordinate: 'disambiguation_index' });
      } else if (!segment && part === 'result' && data?.call?.result_state === 'ambiguous') {
        Object.assign(request, { state: 'choose', candidates: data.call.result_candidates, coordinate: 'result_index' });
      } else {
        if (data?.status !== 'success' || data.call?.call_id !== callId || segment?.part !== part || typeof segment.text !== 'string') {
          throw new Error('No recorded ' + part + ' available for this call yet.');
        }
        Object.assign(request, { state: 'ready', segment, partial: segment.upstream_truncated || data.inspection_complete === false });
      }
    } catch (error) {
      if (activity !== request || !observing()) return;
      Object.assign(request, { state: 'error', text: error.message });
    }
    render(true);
  }

  function recentTools(run, parent) {
    if (!run.tool_snapshots?.length) return;
    element('h3', 'Recent tool calls', parent);
    const list = element('ul', undefined, parent);
    list.className = 'telemetry';
    // One live summary per call ID; the recording inspector owns duplicate candidates.
    const calls = new Map(run.tool_snapshots.map(call => [call.tool_call_id, call]));
    for (const call of [...calls.values()].reverse()) {
      const item = element('li', undefined, list);
      const callKey = JSON.stringify([key(run), call.tool_call_id]);
      const current = activity?.callId === call.tool_call_id ? activity : undefined;
      const collapsed = collapsedTools.get(key(run));
      const open = !collapsed?.has(call.tool_call_id);
      const control = button(undefined, () => {
        if (current) clearActivity();
        if (open) {
          const next = collapsed ?? new Set();
          next.add(call.tool_call_id);
          collapsedTools.set(key(run), next);
        } else collapsed.delete(call.tool_call_id);
        render();
      }, item, { key: 'tool:' + callKey, expanded: open });
      control.className = 'tool-row';
      control.setAttribute('aria-label', call.name + ' (' + call.status + ')');
      element('strong', call.name, control);
      element('span', call.status, control).className = 'badge';
      if (!open && call.args_preview) element('span', call.args_preview, control).className = 'preview';
      if (!open) continue;
      const content = element('div', undefined, item);
      content.className = 'tool-content';
      for (const [label, text] of [['Arguments', call.args_preview], ['Output', call.output_preview], ['Error', call.error_preview]]) {
        if (text) { element('h4', label, content); element('pre', text, content); }
      }
      const controls = element('div', undefined, content);
      controls.className = 'controls';
      for (const part of ['args', 'result']) button(part === 'args' ? 'Recorded args' : 'Recorded result', () => void inspect(run, call.tool_call_id, part), controls, {
        key: part + ':' + callKey, disabled: !observing() || (current?.part === part && current.state === 'loading'),
      });
      if (!current) continue;
      button('Close recording', () => { clearActivity(); render(); }, controls, { key: 'close:' + callKey });
      if (current.state === 'loading') notice('Loading recorded ' + current.part + '…', '', content);
      else if (current.state === 'error') notice(current.text, 'error', content);
      else if (current.state === 'choose') {
        notice('Multiple recordings match; select a candidate.', 'warning', content);
        for (const candidate of current.candidates ?? []) button('Recording ' + (candidate.index + 1) + ' · line ' + candidate.line_number,
          () => void inspect(run, current.callId, current.part, { ...current.selection, [current.coordinate]: candidate.index }), content,
          { disabled: !observing() });
      } else {
        element('h3', 'Recorded ' + current.part, content);
        const segment = current.segment;
        element('pre', segment.text, content).dataset.scrollKey = current.part + ':' + callKey;
        if (Number.isSafeInteger(segment.continuation_offset) && segment.continuation_offset > segment.offset && segment.source_version) {
          button('Next recorded page', () => void inspect(run, current.callId, current.part, { ...current.selection,
            offset: segment.continuation_offset, source_version: segment.source_version }), content, { disabled: !observing() });
        }
        if (current.partial) notice('Partial recording. Inspect the transcript for more.', 'warning', content);
      }
    }
  }

  const rowKey = row => row.kind === 'disk' ? 'disk:' + row.disk.task_id : key(row.run);
  const activeRow = row => row.kind === 'run' && !terminal.has(row.run.status);
  const doneRow = row => row.kind !== 'disk' && !activeRow(row);
  const shownRows = () => doneOnly ? rows.filter(doneRow) : rows;
  const selectedRow = (items = shownRows()) => items.find(row => rowKey(row) === selected) ?? items[0];
  const diskStatus = disk => ['active_external', 'unreconciled'].includes(disk.lock_state) ? 'Busy' : '';
  function rowLabel(row) {
    if (row.kind === 'disk') return [row.disk.task_id, row.disk.cwd, diskStatus(row.disk),
      row.disk.cwd_exists === false ? 'Missing workspace' : ''].filter(Boolean).join(' · ');
    const run = row.run;
    return [run.persona_id, run.task_id.split('/').pop(), run.run_epoch?.slice(0, 8),
      row.kind === 'expired' ? 'Snapshot expired' : row.kind === 'fault' ? 'Refresh failed' : phase(run) ?? 'Pending'].filter(Boolean).join(' · ');
  }

  const route = run => [run.model, run.thinking && 'thinking: ' + run.thinking].filter(Boolean).join(' · ');
  function summary(run) {
    const livePreview = run.live_assistant_preview?.trim() ||
      (active(run) && !run.active_tool && !run.live_thinking ? run.task_preview : undefined);
    return [run.error?.message, run.output_diagnostic?.message, run.active_tool?.name,
      run.result_text ?? run.result_preview ?? livePreview].filter(Boolean).map(text => text.slice(0, 180)).join(' · ').replace(/\s+/g, ' ');
  }

  function statusIcon(run, parent) {
    const node = element('span', undefined, parent);
    const status = run.phase === 'stall_suspected' ? 'stall_suspected' : run.status ?? 'pending';
    node.className = 'status'; node.dataset.status = status; node.title = phase(run) ?? 'Pending';
    node.setAttribute('aria-hidden', 'true'); // The adjacent text carries the label.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ width: '14', height: '14', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' })) svg.setAttribute(name, value);
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', ({ success: 'M3 8l3 3 7-7', failed: 'M4 4l8 8M12 4l-8 8',
      cancelled: 'M5 5h6v6H5z', stall_suspected: 'M8 2l6 11H2zM8 6v3m0 1v1' })[status] ?? 'M8 2a6 6 0 1 0 6 6');
    svg.append(path); node.append(svg);
  }

  function elapsed(run, parent) {
    if (!Number.isFinite(Date.parse(run.started_at)) || terminal.has(run.status)) return;
    const node = element('span', undefined, parent);
    node.className = 'elapsed'; node.dataset.startedAt = run.started_at;
  }

  function runCard(row, selectedRow, list, compact = false) {
    const control = button(undefined, () => { selected = rowKey(row); render(); }, list, {
      key: rowKey(row), pressed: row === selectedRow,
    });
    const label = rowLabel(row);
    control.className = 'run-card';
    control.setAttribute('aria-label', label);
    control.title = [row.run?.task_id ?? row.disk?.task_id, row.run?.run_epoch].filter(Boolean).join(' · ');
    const top = element('span', undefined, control); top.className = 'row';
    const run = row.run;
    if (row.kind === 'run') statusIcon(run, top);
    element('strong', compact && row.kind === 'run' ? (run.persona_id ?? 'Subagent run') : label, top).dir = 'auto';
    if (row.kind === 'run') {
      const model = !compact && route(run), preview = summary(run);
      if (model) element('span', model, control).className = 'model';
      if (preview) element('span', preview, control).className = 'preview';
    }
  }

  function taskAndSession(run, parent) {
    const id = key(run);
    const { card, heading } = section('Task preview', parent);
    if (run.task_preview) {
      copyButton('Copy prompt preview', run.task_preview, heading, id);
      const open = expandedPrompts.has(id);
      button(open ? 'Collapse prompt' : 'Expand prompt', () => {
        if (open) expandedPrompts.delete(id);
        else expandedPrompts.add(id);
        render();
      }, heading, { expanded: open, key: 'prompt:' + id });
      const preview = element('pre', run.task_preview, card);
      preview.className = 'prompt-box'; preview.dataset.expanded = String(open); preview.dataset.scrollKey = 'prompt:' + id;
    }
    textReader(run, 'prompt', card);
    const { card: session, heading: sessionHeader } = section('Session Metadata', parent);
    copyButton('Copy task_id', run.task_id, sessionHeader, id);
    const grid = element('dl', undefined, session); grid.className = 'metadata';
    for (const [label, value] of [['Persona', run.persona_id], ['Status', run.status], ['Phase', phase(run)],
      ['Model', run.model], ['Thinking', run.thinking], ['Started', run.started_at], ['Updated', run.updated_at],
      ['Workspace', run.cwd], ['Epoch', run.run_epoch], ['Session', run.task_id]]) {
      const term = element('dt', label, grid), description = element('dd', value ?? '—', grid);
      if (label === 'Session') { term.className = 'session-label'; description.className = 'session-value'; }
    }
  }

  function tick() {
    for (const elapsed of root.querySelectorAll('[data-started-at]')) {
      const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(elapsed.dataset.startedAt)) / 1000));
      elapsed.textContent = Math.floor(seconds / 60) + 'm ' + seconds % 60 + 's elapsed';
    }
  }

  function renderContent() {
    const header = element('header');
    header.className = 'toolbar';
    element('h1', 'Larva Subagents', header);
    const controls = element('div', undefined, header);
    controls.className = 'controls';
    if (panel && target.kind === 'latest') {
      const query = target.query;
      const filters = element('nav', undefined, controls);
      filters.className = 'controls'; filters.setAttribute('aria-label', 'Run filters');
      const all = !query.task_id && (!query.scope || query.scope === 'recent');
      const filter = (label, focusKey, scope, pressed, done = false) => button(label, () => {
        if (scope === 'recent' && all) { doneOnly = done; render(); }
        else setQuery({ scope, ...(query.limit ? { limit: query.limit } : {}) }, done);
      }, filters, { key: 'filter:' + focusKey, pressed, disabled: !observing() });
      filter('All', 'all', 'recent', all && !doneOnly);
      filter('Active · ' + rows.filter(activeRow).length, 'active', 'active', !query.task_id && query.scope === 'active');
      filter('Done · ' + rows.filter(doneRow).length, 'done', 'recent', all && doneOnly, true);
      filter('Disk', 'disk', 'disk', !query.task_id && query.scope === 'disk');
    }
    if (target.kind === 'latest' || target.kind === 'pinned') button('Refresh', refresh, controls, { disabled: !observing() });
    if (!panel && availableModes.includes(mode === 'inline' ? 'fullscreen' : 'inline')) button(mode === 'inline' ? 'Fullscreen' : 'Inline', changeMode, controls, {
      key: 'display', disabled: !observing() || !!displayRequest,
    });
    if (connection === 'lost') notice('Connection lost. This view is read-only.', 'warning');
    if (readError) notice(readError, 'error');
    if (waitOutcome) notice(waitOutcome, '');
    if (target.kind === 'pending') { notice(panel ? 'Waiting for panel input…' : 'Waiting for this tool call…', ''); return; }
    if (target.kind === 'rejected') { notice(target.message, 'error'); return; }
    for (const failure of failures) {
      if (failure?.error?.message) notice('Startup failed · ' + failure.persona_id + ' · ' + failure.error.message, 'error');
    }
    const items = shownRows(), row = selectedRow(items);
    if (!row) {
      if (!readError) notice(loading ? 'Loading runs…' : 'No runs in this view.', '');
      return;
    }
    const fullscreen = mode === 'fullscreen';
    const run = row.run;
    const id = run ? key(run) : rowKey(row);
    const open = detailsOpen.has(id);
    const main = element('main');
    if (fullscreen) main.className = 'workbench';
    selected = rowKey(row);
    if (fullscreen || items.length > 1) {
      const list = element('nav', undefined, main);
      list.className = fullscreen ? 'run-list' : open ? 'switcher' : 'compact-list';
      list.dataset.scrollKey = 'list';
      list.setAttribute('aria-label', 'Subagent runs');
      const group = (title, groupRows) => {
        if (!groupRows.length) return;
        element('h3', title + ' · ' + groupRows.length, list);
        for (const item of groupRows) runCard(item, row, list);
      };
      if (fullscreen) {
        group('Active', items.filter(activeRow));
        group('Done', items.filter(doneRow));
        group('Disk', items.filter(item => item.kind === 'disk'));
      } else for (const item of items) runCard(item, row, list, !open);
    }
    const detail = element('article', undefined, main);
    if (fullscreen) {
      detail.className = 'inspector'; detail.dataset.scrollKey = 'detail:' + id;
    }
    if (row.kind === 'expired') {
      notice('Run snapshot expired (inspect recorded transcript)', 'warning', detail);
      pathLine('Recorded transcript', row.run.task_id, detail);
      copyButton('Copy task_id', row.run.task_id, detail, key(row.run));
      return;
    }
    if (row.kind === 'fault') notice(row.error.message, 'error', detail);
    if (row.kind === 'disk') {
      element('h2', 'Recorded session', detail);
      pathLine('Workspace', row.disk.cwd, detail);
      pathLine('Recorded transcript', row.disk.task_id, detail);
      if (diskStatus(row.disk)) notice('Busy', 'warning', detail);
      if (row.disk.cwd_exists === false) notice('Missing workspace', 'warning', detail);
      if (!run) {
        copyButton('Copy task_id', row.disk.task_id, detail, rowKey(row));
        const { card } = section('Task prompt', detail);
        textReader(row.disk, 'prompt', card);
        return;
      }
    }
    const bar = element('div', undefined, detail);
    bar.className = fullscreen ? 'row detail-header' : 'toolbar';
    statusIcon(run, bar);
    const heading = element(fullscreen ? 'h2' : 'strong', run.persona_id ?? 'Subagent run', bar);
    heading.dir = 'auto';
    const status = ({ accepted: 'Accepted', running: 'Running' })[run.status];
    element('span', [status, phase(run) ?? 'Pending'].filter(Boolean).join(' · '), bar)
      .className = run.phase === 'stall_suspected' ? 'badge warning' : 'badge';
    elapsed(run, bar);
    if (Number.isSafeInteger(run.tool_call_count)) element('span', run.tool_call_count + ' tool calls', bar).className = 'badge';
    for (const [state, label] of [['delivery_failed', 'Delivery failed'], ['evicted', 'Output evicted']]) {
      if (run.output_state === state) element('span', label, bar).className = 'badge warning';
    }
    if (run.cleanup_unconfirmed) element('span', 'Cleanup unconfirmed', bar).className = 'badge warning';
    const model = route(run);
    if (model) element('span', model, bar).className = 'model';
    if (run.active_tool) element('span', run.active_tool.name + ' (' + run.active_tool.status + ')', bar);
    if (run.live_thinking) element('span', 'Thinking…', bar);
    if (row.kind === 'run' && pair(run) && (active(run) || run.cleanup_unconfirmed) && observing()) {
      button(run.cleanup_unconfirmed ? 'Retry cleanup' : 'Cancel', () => void cancel(run), bar, {
        key: 'cancel:' + id, disabled: loading || cancelling.has(id),
      }).className = 'cancel';
    }
    const cancelNotice = cancelNotices.get(id);
    if (cancelNotice) notice(cancelNotice.text, cancelNotice.style, detail);
    if (!fullscreen) {
      button(open ? 'Hide details' : 'Details', () => {
        if (open) detailsOpen.delete(id);
        else detailsOpen.add(id);
        render();
      }, bar, { key: 'details:' + id, expanded: open });
      if (!open) {
        const preview = summary(run);
        if (preview) element('p', preview, detail).className = 'preview summary';
        return;
      }
    } else {
      const inspector = element('nav', undefined, detail);
      inspector.className = 'tabs';
      inspector.setAttribute('aria-label', 'Run inspector');
      for (const label of tabs) button(label, () => { tab = label; render(); }, inspector, { key: 'tab:' + label, pressed: tab === label });
    }
    const body = element('div', undefined, detail);
    body.className = fullscreen ? 'tab-body' : 'drawer';
    if (!fullscreen) body.dataset.scrollKey = 'drawer:' + id;
    const shows = label => !fullscreen || tab === 'All' || tab === label;
    if (shows('Task & Session')) taskAndSession(run, body);
    if (shows('Timeline')) {
      const { card } = section('Timeline', body);
      if (active(run)) element('p', run.active_tool ? 'Active tool: ' + run.active_tool.name
        : run.live_thinking ? 'Thinking…' : phase(run), card).className = 'activity';
      if (run.live_assistant_preview) {
        element('h3', 'Live assistant preview', card);
        const preview = element('pre', run.live_assistant_preview, card);
        preview.className = 'stream'; preview.dataset.scrollKey = 'stream:' + id;
      }
      if (run.tool_snapshots?.length) recentTools(run, card);
      else element('p', 'No tool calls yet.', card).className = 'muted';
    }
    if (shows('Result')) output(run, body);
  }

  function render(background = false) {
    if (!visible() || connection === 'closed') return;
    const selection = document.getSelection?.();
    if (background && selection && !selection.isCollapsed && root.contains(selection.anchorNode)) {
      renderDeferred = true;
      return;
    }
    renderDeferred = false;
    renderVersion++;
    const liveRuns = new Map(rows.filter(row => row.kind !== 'expired' && row.run).map(row => [key(row.run), row.run]));
    for (const state of [detailsOpen, expandedPrompts, cancelNotices]) {
      for (const id of state.keys()) if (!liveRuns.has(id)) state.delete(id);
    }
    for (const [id, collapsed] of collapsedTools) {
      const calls = liveRuns.get(id)?.tool_snapshots;
      for (const callId of collapsed) if (!calls?.some(call => call.tool_call_id === callId)) collapsed.delete(callId);
      if (!collapsed.size) collapsedTools.delete(id);
    }
    if (textRead) {
      const row = selectedRow(), run = row?.run ?? row?.disk;
      if (!run || row.kind === 'expired' || key(run) !== textRead.runKey) clearTextRead();
    }
    if (activity) {
      const row = selectedRow();
      const run = row?.run;
      if (row?.kind === 'expired' || !run || key(run) !== activity.runKey || (mode === 'inline' && !detailsOpen.has(activity.runKey)) ||
          !run.tool_snapshots?.some(call => call.tool_call_id === activity.callId)) clearActivity();
    }
    const focus = document.activeElement?.dataset?.focusKey;
    const scroll = new Map(Array.from(root.querySelectorAll('[data-scroll-key]'), node => [node.dataset.scrollKey, node.scrollTop]));
    document.documentElement.dataset.mode = mode;
    root.replaceChildren();
    renderContent();
    for (const node of root.querySelectorAll('[data-scroll-key]')) if (scroll.has(node.dataset.scrollKey)) node.scrollTop = scroll.get(node.dataset.scrollKey);
    if (focus) Array.from(root.querySelectorAll('button')).find(node => node.dataset.focusKey === focus)?.focus({ preventScroll: true });
    tick();
    measure();
    if (observing() && clockTimer === undefined) clockTimer = setInterval(tick, 1000);
  }

  let lastHeight;
  function measure() {
    if (!observing() || mode !== 'inline') { lastHeight = undefined; return; }
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (height !== lastHeight) { lastHeight = height; notify('ui/notifications/size-changed', { height }); }
  }
  const observer = new ResizeObserver(measure);
  observer.observe(root, { box: 'border-box' });
  document.addEventListener('selectionchange', () => { if (renderDeferred) render(true); });
  document.addEventListener('visibilitychange', () => {
    if (!visible()) { stopObserving(); lastHeight = undefined; }
    else {
      loading = true;
      reopen();
    }
  });
  window.addEventListener('messageerror', event => { if (event.source === window.parent) disconnect(); });
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window.parent || message?.jsonrpc !== '2.0' || connection === 'closed') return;
    if (message.method === 'ui/resource-teardown') {
      connection = 'closed';
      finishInvocation();
      stopObserving();
      retireRequests(() => true);
      observer.disconnect();
      if (Object.hasOwn(message, 'id')) post({ id: message.id, result: {} });
      return;
    }
    if (connection === 'lost') return;
    if (!message.method) {
      const request = requests.get(message.id);
      if (!request) return;
      requests.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    switch (message.method) {
      case 'ui/notifications/host-context-changed':
        applyContext(message.params?.hostContext ?? message.params); break;
      case 'ui/notifications/tool-input':
        if (message.params?.arguments && typeof message.params.arguments === 'object' && !Array.isArray(message.params.arguments)) {
          if (panel && (target.kind === 'pending' || target.kind === 'latest')) setQuery(queryFor(message.params.arguments, 'recent'));
          else if (target.kind === 'pending' && toolInput === undefined) {
            toolInput = invocationFor(message.params.arguments);
            applyInvocation();
          }
        }
        break;
      case 'ui/notifications/tool-result':
        if (!panel && target.kind === 'pending' && initialResult === undefined && message.params && typeof message.params === 'object') {
          initialResult = message.params;
          applyInvocation();
        }
        break;
      case 'ui/notifications/tool-cancelled':
        if (target.kind === 'pending') {
          target = { kind: 'rejected', message: message.params?.reason ?? 'The tool call was cancelled before binding a run.' };
          finishInvocation();
          render();
        }
        break;
    }
  });
  render();
  rpc('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'Larva Subagents', version },
    appCapabilities: { availableDisplayModes: modes } }, 'initialize').then(result => {
    if (connection !== 'connecting') return;
    connection = 'ready';
    notify('ui/notifications/initialized');
    applyContext(result?.hostContext);
    void refresh();
  }).catch(disconnect);
}`;

// src/ui/codex-widget-html.ts
var CODEX_WIDGET_URI = "ui://larva-pi-subagent/widget-v4";
var CODEX_WIDGET_DISPLAY_MODES = ["inline", "fullscreen"];
function renderCodexWidgetHtml(version) {
  return renderCodexAppHtml("widget", CODEX_WIDGET_DISPLAY_MODES, version);
}

// src/surfaces/tool-schemas.ts
var isPlainObject = (value) => {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
};
var hasRequired = (value, keys2) => keys2.every((key) => Object.hasOwn(value, key));
function matches(schema, value) {
  if ("anyOf" in schema) return schema.anyOf.some((option) => matches(option, value));
  if (!("type" in schema)) return isPlainObject(value) && hasRequired(value, schema.required);
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string" || schema.minLength && !value.length || schema.enum && !schema.enum.includes(value)) return false;
      if (schema.maxLength === void 0) return true;
      let length = 0;
      for (const _ of value) if (++length > schema.maxLength) return false;
      return true;
    }
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
    case "array":
      return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) && (!schema.uniqueItems || new Set(value).size === value.length) && value.every((item) => matches(schema.items, item));
    case "object": {
      if (!isPlainObject(value) || !hasRequired(value, schema.required ?? []) || schema.not && matches(schema.not, value)) return false;
      return Object.entries(value).every(([key, field2]) => Object.hasOwn(schema.properties, key) && matches(schema.properties[key], field2));
    }
  }
}
function admitToolInput(name, schema, input) {
  if (!matches(schema, input)) throw new LarvaError("LARVA_BAD_INPUT", `Invalid arguments for ${name}.`);
  return input;
}
var string = { type: "string" };
var text = { ...string, minLength: 1 };
var boolean = { type: "boolean" };
var integer2 = (minimum, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum });
var choice = (...values) => ({ ...string, enum: values });
var object3 = (properties, ...required) => ({ type: "object", properties, required, additionalProperties: false });
var described = (schema, description) => ({ ...schema, description });
var personaId = described(text, "Lowercase kebab-case Persona ID.");
var taskId = described(text, "Exact canonical child session task_id.");
var runEpoch = described(text, "Opaque run_epoch from the accepted receipt or status snapshot.");
var taskIds = described(
  { type: "array", items: taskId, minItems: 1, maxItems: 25, uniqueItems: true },
  "One to 25 distinct child session handles."
);
var epochGuard = object3({ task_id: taskId, run_epoch: runEpoch }, "task_id", "run_epoch");
var epochs = { type: "array", items: epochGuard, maxItems: 25 };
var maxMs = 864e5;
var maxSliceLength = 4e3;
var commonToolSchemas = {
  larva_personas: object3({
    query: described(string, "Search Persona IDs, descriptions, and model routes."),
    limit: described(integer2(1, 50), "Maximum matches (default 20).")
  }),
  larva_subagent: object3({
    persona_id: personaId,
    task: described(text, "Instructions for the fresh or resumed child run."),
    task_id: described(taskId, "Exact child session handle to resume; omit to start a new session."),
    cwd: described(text, "Absolute workspace directory; omit on resume to use the recorded workspace."),
    no_progress_timeout_ms: described(integer2(12e4, maxMs), "Consecutive silence in milliseconds before cancellation."),
    stall_alert_ms: described(
      { anyOf: [integer2(0, 0), integer2(6e4, maxMs)] },
      "Consecutive silence in milliseconds before a stall alert, or 0 to disable it."
    )
  }, "persona_id", "task"),
  larva_subagent_wait: object3({
    task_ids: taskIds,
    return_when: described(choice("all", "any", "first_error"), "Readiness condition (default all)."),
    timeout_ms: described(integer2(0, maxMs), "Total wait budget in milliseconds; 0 returns an immediate snapshot.")
  }, "task_ids"),
  larva_subagent_status: {
    ...object3({
      task_id: taskId,
      scope: described(choice("active", "recent", "disk"), "List active, recent, or recorded runs (default recent)."),
      limit: described(integer2(1, 25), "Maximum list entries (default 10).")
    }),
    not: { anyOf: [{ required: ["task_id", "scope"] }, { required: ["task_id", "limit"] }] }
  },
  larva_subagent_activity: object3({
    task_id: taskId,
    limit: described(integer2(1, 20), "Maximum recent calls (default 5)."),
    cursor: described(text, "Opaque cursor for the next incremental page."),
    tool_name: described(text, "Exact recorded tool name."),
    since_timestamp: described(text, "Inclusive timezone-qualified ISO timestamp lower bound."),
    until_timestamp: described(text, "Inclusive timezone-qualified ISO timestamp upper bound."),
    tool_call_id: described(text, "Exact recorded tool-call ID for detail or segment lookup."),
    disambiguation_index: described(integer2(0), "Zero-based candidate index for a duplicated tool-call ID."),
    entry_id: described(text, "Recorded entry ID to disambiguate a duplicated tool-call ID."),
    result_index: described(integer2(0), "Zero-based recorded result index in file order."),
    segment_part: described(choice("args", "result"), "Read saved arguments or a recorded result (default result)."),
    offset: described(integer2(0), "UTF-16 code-unit offset in the saved JSON."),
    length: described(integer2(1, maxSliceLength), "Maximum UTF-16 code units to return."),
    source_version: described(text, "Source version token required for nonzero offsets.")
  }, "task_id"),
  larva_subagent_cancel: object3({
    task_ids: taskIds,
    reason: described({ ...text, maxLength: 500 }, "Cancellation reason, up to 500 code points."),
    expected_run_epochs: described(epochs, "Optional epoch guards to avoid cancelling newer runs after a resume.")
  }, "task_ids", "reason")
};
var personaSwitchSchema = object3({
  persona_id: personaId,
  reason: described({ ...text, maxLength: 1e3 }, "Why the switch is needed. The switch handler caps the reason at 1,000 UTF-16 code units."),
  continue_task: described(boolean, "Run an immediate continuation. This must be the only tool call in the message.")
}, "persona_id", "reason");
var searchMentionsSchema = object3({
  query: described(string, "Text entered for Persona mention search."),
  preload: described(boolean, "Request preload results."),
  path: described({ type: "array", items: text }, "Non-empty components of the mention path.")
}, "query");
var statusSchema = commonToolSchemas.larva_subagent_status;
var subagentPanelSchema = {
  ...statusSchema,
  properties: {
    ...statusSchema.properties,
    run_epochs: described({ ...epochs, minItems: 1 }, "Pin refreshes to the exact run instances."),
    slice: described(object3({
      task_id: taskId,
      run_epoch: runEpoch,
      source: described(choice("prompt", "output"), "Read the initial prompt or completion output."),
      offset: described(integer2(0), "Zero-based code-point offset."),
      length: described(integer2(1, maxSliceLength), "Maximum code points to return.")
    }, "task_id", "source"), "Read a bounded page from a run's prompt or output.")
  }
};

// src/surfaces/mcp-tools.ts
var bad2 = (message) => {
  throw new LarvaError("LARVA_BAD_INPUT", message);
};
var { larva_subagent: spawnSchema, larva_subagent_status: statusSchema2 } = commonToolSchemas;
var modelUi = { ui: { visibility: ["model", "app"] } };
var widgetUi = {
  ui: { ...modelUi.ui, resourceUri: CODEX_WIDGET_URI },
  "openai/ui": { preferredModelDisplayMode: "inline", availableDisplayModes: CODEX_WIDGET_DISPLAY_MODES }
};
function tool(name, description, inputSchema, _meta, handler) {
  return {
    definition: { name, description, inputSchema, _meta },
    invoke(input, listRoots, signal) {
      return handler(admitToolInput(name, inputSchema, input), listRoots, signal);
    }
  };
}
function result(data, text2, isError = false) {
  return { content: [{ type: "text", text: text2 }], structuredContent: data, isError };
}
var describeRuns = (data) => `${data.disk_sessions?.length ?? data.runs.length} ${data.disk_sessions ? "recorded sessions" : "run snapshots"}; ${data.startup_failures.length} startup failures.`;
function createMcpTools(supervisor, personas, maxMessageBytes2) {
  function checkCatalogSize(rows, copies) {
    let bytes = 0;
    for (const row of rows) {
      bytes += copies * Buffer.byteLength(JSON.stringify(row));
      if (bytes > maxMessageBytes2) {
        throw new LarvaError("LARVA_INTERNAL_ERROR", "Catalog response exceeds the transport limit. Narrow the query.", { matches: rows.length });
      }
    }
  }
  const registry = [
    tool(
      "larva_personas",
      "Search installed Larva personas without returning prompts.",
      commonToolSchemas.larva_personas,
      modelUi,
      async (args) => {
        const matches2 = await personas.list({ ...args, limit: args.limit ?? 20 });
        checkCatalogSize(matches2, 1);
        return result({ personas: matches2 }, `${matches2.length} matching personas.`);
      }
    ),
    tool("larva_subagent", "Start or resume an isolated Pi subagent.", {
      ...spawnSchema,
      properties: { ...spawnSchema.properties, wait_for_completion: boolean, parent_persona_id: text }
    }, widgetUi, async (args, listRoots, signal) => {
      const context = { surface: "mcp", listRoots, signal };
      const data = await supervisor.spawn(args, context);
      return result(data, `${args.persona_id}: ${data.status}.`, data.status === "failed" || data.status === "cancelled");
    }),
    tool(
      "larva_subagent_wait",
      "Observe exact run instances without consuming their outputs.",
      commonToolSchemas.larva_subagent_wait,
      widgetUi,
      async (args, _, signal) => {
        const data = await supervisor.wait(args, "mcp", signal);
        return result(data, `${data.ready ? "Wait ready" : "Wait not ready"}${data.timed_out ? " (timed out)" : ""}; ${data.runs.length} run snapshots.`);
      }
    ),
    tool(
      "larva_subagent_status",
      "Inspect an exact task or list active, recent, or recorded sessions.",
      statusSchema2,
      widgetUi,
      async (args) => {
        const data = await supervisor.status(args);
        return result(data, describeRuns(data));
      }
    ),
    tool(
      "larva_subagent_activity",
      "Read recorded tool activity from an exact task transcript.",
      commonToolSchemas.larva_subagent_activity,
      modelUi,
      async (args) => {
        return mcpActivityResult(await inspectSubagentActivity(supervisor.home, args));
      }
    ),
    tool(
      "larva_subagent_cancel",
      "Cancel active local runs by exact task_id (omit expected_run_epochs unless guarding against a concurrent resume).",
      commonToolSchemas.larva_subagent_cancel,
      modelUi,
      async (args) => {
        const data = await supervisor.cancel(args);
        return result(data, data.results.map(({ outcome }) => outcome.replaceAll("_", " ")).join(", ") + ".", data.isError);
      }
    ),
    tool(
      "search_mentions",
      "Find Persona mention resources.",
      searchMentionsSchema,
      { ui: { visibility: ["app"] }, "openai/extensions": { "mentions/search": { preload: true } } },
      async (args) => {
        const data = await buildSearchMentionsOutput(personas, args);
        checkCatalogSize(data.items, 2);
        return { content: [{ type: "text", text: `${data.items.length} matching Persona resources.` }, ...data.items], structuredContent: data, isError: false };
      }
    ),
    tool(
      "larva_subagent_panel",
      "View sessions or recover exact run epochs for an inline card.",
      {
        ...subagentPanelSchema,
        not: { anyOf: [
          ...statusSchema2.not.anyOf,
          ...["task_id", "scope", "limit", "run_epochs"].map((key) => ({ required: ["slice", key] })),
          ...["task_id", "scope", "limit"].map((key) => ({ required: ["run_epochs", key] }))
        ] }
      },
      {
        ui: { visibility: ["app"], resourceUri: CODEX_PANEL_URI },
        "openai/ui": { entrypoints: [{ type: "thread" }], availableDisplayModes: CODEX_PANEL_DISPLAY_MODES }
      },
      async ({ run_epochs, slice, ...query }) => {
        if (slice) {
          const page = await supervisor.readRunTextSlice(slice);
          return result(
            { runs: [], startup_failures: [], slice: page },
            page.state === "ok" ? `Read ${page.length} code points of ${slice.source}.` : "Text slice unavailable."
          );
        }
        if (!run_epochs) {
          const data = await supervisor.status(query);
          return result(data, describeRuns(data));
        }
        if (new Set(run_epochs.map(({ task_id }) => task_id)).size !== run_epochs.length) {
          return bad2("Pinned epochs must have unique task_ids.");
        }
        const runs = [];
        const row_errors = [];
        const settled = await Promise.allSettled(run_epochs.map(({ task_id, run_epoch }) => supervisor.pinned(task_id, run_epoch)));
        for (const [index, outcome] of settled.entries()) {
          if (outcome.status === "fulfilled") {
            if ("status" in outcome.value) runs.push(outcome.value);
          } else row_errors.push({ ...run_epochs[index], ...toErrorEnvelope(outcome.reason) });
        }
        return result({ runs, startup_failures: [], row_errors }, `${runs.length} pinned runs; ${row_errors.length} row errors.`);
      }
    )
  ];
  return {
    definitions: registry.map((entry) => entry.definition),
    async call(name, args, listRoots, signal) {
      try {
        signal?.throwIfAborted();
        const entry = registry.find((item) => item.definition.name === name);
        if (!entry) return bad2("Unknown tool name.");
        if (!isRecord(args)) return bad2(`Invalid arguments for ${name}.`);
        return await entry.invoke(args, listRoots, signal);
      } catch (error) {
        const data = toErrorEnvelope(error);
        return result(data, data.error.message, true);
      }
    }
  };
}

// src/mcp-server.ts
var versions = ["2026-07-28", "2025-11-25"];
var resourcePageSize = 50;
var maxMessageBytes = 8 * 1024 * 1024;
var maxIdBytes = 1024;
var maxHeaderBytes = 8192;
var maxConcurrentRequests = 128;
var rootsTimeoutMs = 5e3;
var decoder4 = new TextDecoder("utf-8", { fatal: true });
var isId = (value) => value === null || typeof value === "string" && Buffer.byteLength(JSON.stringify(value)) <= maxIdBytes || typeof value === "number" && Number.isFinite(value);
function encodeFrame(message, framing) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  const bodyBytes = Buffer.byteLength(body);
  if (framing === "line") return { frame: `${body}
`, bytes: bodyBytes + 1 };
  const header = `Content-Length: ${bodyBytes}\r
\r
`;
  return { frame: header + body, bytes: header.length + bodyBytes };
}
function stdioReader(message) {
  let buffer = Buffer.alloc(0), used = 0;
  let length, headerBytes = 0, readingBody = false;
  function append(bytes, max) {
    const next = used + bytes.length;
    if (next > max) return false;
    if (next > buffer.length) {
      const grown = Buffer.allocUnsafe(Math.min(max, Math.max(next, 1024, buffer.length * 2)));
      buffer.copy(grown, 0, 0, used);
      buffer = grown;
    }
    bytes.copy(buffer, used);
    used = next;
    return true;
  }
  function emit(framing) {
    const body = buffer.subarray(0, used);
    used = 0;
    message(body, framing);
    if (buffer.length > 65536) buffer = Buffer.alloc(0);
  }
  function feed(chunk) {
    let at = 0;
    while (at < chunk.length) {
      if (readingBody) {
        const end2 = Math.min(chunk.length, at + length - used);
        if (!append(chunk.subarray(at, end2), maxMessageBytes)) return false;
        at = end2;
        if (used === length) {
          emit("length");
          length = void 0;
          headerBytes = 0;
          readingBody = false;
        }
        continue;
      }
      const newline = chunk.indexOf(10, at);
      const end = newline < 0 ? chunk.length : newline;
      if (!append(chunk.subarray(at, end), length === void 0 ? maxMessageBytes : maxHeaderBytes - headerBytes)) return false;
      if (newline < 0) break;
      at = newline + 1;
      const line = buffer.subarray(0, used);
      if (length === void 0 && !/^content-length:/i.test(line.toString("latin1", 0, 15))) {
        if (used === 0 || used === 1 && line[0] === 13) used = 0;
        else emit("line");
        continue;
      }
      headerBytes += used + 1;
      used = 0;
      if (headerBytes > maxHeaderBytes) return false;
      if (length === void 0) {
        const match = /^content-length:[ \t]*(\d+)[ \t]*\r$/i.exec(line.toString("latin1"));
        if (!match || Number(match[1]) > maxMessageBytes) return false;
        length = Number(match[1]);
      } else if (line.length === 1 && line[0] === 13) {
        if (length === 0) {
          emit("length");
          length = void 0;
          headerBytes = 0;
        } else readingBody = true;
      } else if (!/^(?!content-length:)[a-z0-9-]+:[\t\x20-\x7e]*\r$/i.test(line.toString("latin1"))) return false;
    }
    return true;
  }
  return { feed, complete: () => used === 0 && length === void 0 };
}
async function packageVersion() {
  if (true) return "0.9.0";
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  if (!isRecord(manifest) || typeof manifest.version !== "string") throw new Error("Package version is unavailable.");
  return manifest.version;
}
var appMime = "text/html;profile=mcp-app";
var apps = [
  { uri: CODEX_PANEL_URI, name: "Larva Subagents Panel", modes: CODEX_PANEL_DISPLAY_MODES, render: renderCodexPanelHtml },
  { uri: CODEX_WIDGET_URI, name: "Larva Subagents Widget", modes: CODEX_WIDGET_DISPLAY_MODES, render: renderCodexWidgetHtml }
].map(({ uri, name, modes, render }) => ({
  resource: {
    uri,
    name,
    mimeType: appMime,
    _meta: { ui: { prefersBorder: true }, "openai/ui": { preferredDisplayMode: modes[0], availableDisplayModes: modes } }
  },
  render
}));
async function runMcpServer(env = process.env) {
  const { stdin, stdout } = process;
  const home = env.HOME || homedir4();
  const path = env.PATH ? env.PATH.split(delimiter2) : [];
  for (const dir of [join12(home, ".local", "bin"), join12(home, ".pi", "agent", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    if (!path.includes(dir) && (await stat7(dir).catch(() => void 0))?.isDirectory()) path.push(dir);
  }
  const supervisor = new SubagentSupervisor({
    env: { ...env, PATH: path.join(delimiter2) },
    ...import.meta.url.endsWith(".ts") && {
      extension: fileURLToPath2(new URL("./pi-extension.ts", import.meta.url)),
      preload: fileURLToPath2(new URL("./child-rpc-preload.ts", import.meta.url))
    }
  });
  const personas = new PersonaStore(supervisor.home);
  const tools = createMcpTools(supervisor, personas, maxMessageBytes);
  let rootsSupported = false, closed = false, eof = false, failed = false, running = 0;
  let version;
  const stopped = Promise.withResolvers();
  const pendingRoots = /* @__PURE__ */ new Map();
  const requests = /* @__PURE__ */ new Map();
  let shutdown;
  const brokenOutput = Promise.withResolvers();
  function stop(mode) {
    if (mode === "fault" || mode === "output") failed = true;
    if (mode === "output") brokenOutput.resolve();
    if (mode !== "eof") closed = true;
    stdin.pause();
    const pending = Array.from(requests.values());
    for (const request of pending) if (closed || request.detachOnEof) request.controller.abort();
    shutdown ??= (async () => {
      const [{ settled }] = await Promise.all([supervisor.shutdown(), ...pending.map(({ work }) => work)]);
      if (!stdout.destroyed && stdout.writableLength) {
        await Promise.race([brokenOutput.promise, new Promise((resolve7) => stdout.write("", () => resolve7()))]);
      }
      closed = true;
      stopped.resolve(settled && !failed ? 0 : 1);
    })().catch(stopped.reject);
  }
  function send(message, framing) {
    if (closed) return;
    let output = encodeFrame(message, framing);
    if (output.bytes > maxMessageBytes) {
      const error = { code: -32603, message: "Response exceeds the transport limit." };
      output = encodeFrame({ id: message.id, error }, framing);
    }
    if (stdout.writableLength > 0 && stdout.writableLength + output.bytes > maxMessageBytes) {
      stop("fault");
      return;
    }
    stdout.write(output.frame);
  }
  function rpcError(id, code, message, framing, data) {
    send({ id, error: { code, message, data } }, framing);
  }
  function listRoots(framing, signal) {
    signal.throwIfAborted();
    if (closed || eof) return Promise.resolve({ roots: [] });
    const id = `roots:${randomUUID5()}`;
    const reply = Promise.withResolvers();
    const timeout = setTimeout(reply.resolve, rootsTimeoutMs, void 0);
    const abort = () => reply.resolve(void 0);
    signal.addEventListener("abort", abort, { once: true });
    pendingRoots.set(id, reply.resolve);
    send({ id, method: "roots/list" }, framing);
    return reply.promise.then((value) => {
      signal.throwIfAborted();
      if (!isRecord(value) || !Array.isArray(value.roots) || value.roots.length !== 1) return { roots: [] };
      const root = value.roots[0];
      return { roots: isRecord(root) && typeof root.uri === "string" ? [{ uri: root.uri }] : [] };
    }).finally(() => {
      clearTimeout(timeout);
      pendingRoots.delete(id);
      signal.removeEventListener("abort", abort);
    });
  }
  async function dispatch(id, method, params, framing, signal) {
    const invalid6 = (message) => rpcError(id, -32602, message, framing);
    let result2;
    switch (method) {
      case "initialize":
        rootsSupported = isRecord(params.capabilities) && isRecord(params.capabilities.roots);
        result2 = {
          protocolVersion: typeof params.protocolVersion === "string" && versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "larva-pi-subagent", title: "Larva Subagents", version: await (version ??= packageVersion()) },
          instructions: CODEX_INITIALIZE_INSTRUCTIONS
        };
        break;
      case "ping":
        result2 = {};
        break;
      case "tools/list":
        result2 = { tools: tools.definitions };
        break;
      case "tools/call": {
        if (typeof params.name !== "string") return invalid6("Expected a tool name.");
        result2 = await tools.call(
          params.name,
          params.arguments === void 0 ? {} : params.arguments,
          rootsSupported ? () => listRoots(framing, signal) : void 0,
          signal
        );
        break;
      }
      case "resources/templates/list":
        result2 = { resourceTemplates: [{ uriTemplate: CODEX_PERSONA_URI_TEMPLATE, name: "larva-persona", title: "Larva Persona", mimeType: "text/markdown" }] };
        break;
      case "resources/list": {
        const { cursor } = params;
        if (cursor !== void 0 && (typeof cursor !== "string" || !/^r:[1-9]\d*$/.test(cursor))) return invalid6("Invalid resource cursor.");
        const start = typeof cursor === "string" ? Number(cursor.slice(2)) : 0;
        const catalog = await personas.list();
        const total = apps.length + catalog.length;
        if (!Number.isSafeInteger(start) || start > total) return invalid6("Invalid resource cursor.");
        const resources = [];
        let bytes = 0, index = start;
        for (; index < total && resources.length < resourcePageSize; index++) {
          const persona = catalog[index - apps.length];
          const row = index < apps.length ? apps[index].resource : {
            uri: personaResourceUri(persona.id),
            name: persona.id,
            title: `@larva:${persona.id}`,
            mimeType: "text/markdown",
            description: persona.description
          };
          bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
          if (bytes > maxMessageBytes / 2 && resources.length) break;
          resources.push(row);
        }
        result2 = { resources, ...index < total && { nextCursor: `r:${index}` } };
        break;
      }
      case "resources/read": {
        const uri = params.uri;
        if (typeof uri !== "string") return invalid6("Expected a resource URI.");
        const app2 = apps.find((entry) => entry.resource.uri === uri);
        if (app2) {
          const { mimeType, _meta } = app2.resource;
          result2 = { contents: [{ uri, mimeType, _meta, text: app2.render(await (version ??= packageVersion())) }] };
          break;
        }
        const personaId2 = parsePersonaResourceUri(uri);
        if (!personaId2) return invalid6("Unknown or invalid resource URI.");
        const spec = await personas.get(personaId2);
        result2 = { contents: [{
          uri,
          mimeType: "text/markdown",
          text: `# @larva:${spec.id}

${spec.description}

- **persona_id**: \`${spec.id}\`
- **model**: \`${spec.model}\`
- **delegation**: Call \`larva_subagent\` with \`persona_id: "${spec.id}"\`.
`
        }] };
        break;
      }
      default:
        return rpcError(id, -32601, "Method not found", framing);
    }
    if (!signal.aborted) send({ id, result: result2 }, framing);
  }
  const reader = stdioReader((body, framing) => {
    if (closed || eof) return;
    let message;
    try {
      message = JSON.parse(decoder4.decode(body));
    } catch {
      return rpcError(null, -32700, "Parse error", framing);
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      return rpcError(null, -32600, "Invalid Request", framing);
    }
    const { id, method, params } = message;
    if (id !== void 0 && !isId(id)) return rpcError(null, -32600, "Invalid Request", framing);
    if (!Object.hasOwn(message, "method")) {
      if (typeof id === "string") {
        const settle = pendingRoots.get(id);
        if (settle) {
          const hasResult = Object.hasOwn(message, "result"), hasError = Object.hasOwn(message, "error");
          pendingRoots.delete(id);
          settle(hasResult && !hasError ? message.result : void 0);
          return;
        }
      }
      if (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")) {
        rpcError(id ?? null, -32600, "Invalid Request", framing);
      }
      return;
    }
    if (typeof method !== "string") return rpcError(id ?? null, -32600, "Invalid Request", framing);
    if (id === void 0) {
      if (method === "notifications/cancelled" && isRecord(params) && isId(params.requestId)) {
        requests.get(params.requestId)?.controller.abort();
      }
      return;
    }
    if (params !== void 0 && !isRecord(params)) return rpcError(id, -32602, "Expected named parameters", framing);
    if (requests.has(id)) return rpcError(null, -32600, "Request ID is already in use", framing);
    if (running >= maxConcurrentRequests) return rpcError(id, -32e3, "Too many concurrent requests", framing);
    const controller = new AbortController(), { signal } = controller;
    const detachOnEof = method === "tools/call" && (params?.name === "larva_subagent" || params?.name === "larva_subagent_wait");
    const cancelled2 = Promise.withResolvers();
    const abort = () => cancelled2.resolve();
    signal.addEventListener("abort", abort, { once: true });
    ++running;
    const dispatched = Promise.resolve().then(() => {
      if (!signal.aborted) return dispatch(id, method, params ?? {}, framing, signal);
    }).catch((error) => {
      if (signal.aborted) return;
      const { error: info } = toErrorEnvelope(error);
      const code = info.code === "LARVA_PERSONA_NOT_FOUND" ? -32002 : -32603;
      rpcError(id, code, info.message, framing, info);
    }).finally(() => {
      --running;
    });
    const work = Promise.race([dispatched, cancelled2.promise]).finally(() => {
      signal.removeEventListener("abort", abort);
      requests.delete(id);
    });
    requests.set(id, { controller, work, detachOnEof });
  });
  const feed = (chunk) => {
    if (!reader.feed(chunk)) stop("fault");
  };
  const onEnd = () => {
    eof = true;
    stop(reader.complete() ? "eof" : "fault");
  };
  const onFault = () => stop("fault");
  const onClose = () => {
    if (!eof) onFault();
  };
  const onOutputError = () => stop("output");
  const onSignal = () => stop("signal");
  const signals = ["SIGTERM", "SIGINT"];
  for (const signal of signals) process.on(signal, onSignal);
  stdout.on("error", onOutputError);
  stdin.on("end", onEnd).on("close", onClose).on("error", onFault).on("data", feed);
  if (stdin.readableEnded) onEnd();
  else if (stdin.destroyed) onClose();
  try {
    return await stopped.promise;
  } finally {
    stdin.off("data", feed).off("end", onEnd).off("close", onClose).off("error", onFault);
    stdout.off("error", onOutputError);
    for (const signal of signals) process.off(signal, onSignal);
  }
}
if (larvaIsMain) {
  process.exit(await runMcpServer());
}
export {
  runMcpServer
};
