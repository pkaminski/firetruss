import _ from 'lodash';
import Vue from 'vue';
import performanceNow from 'performance-now';

/* globals window */

let earlyDigestPending;
let bareDigest = function() {
  earlyDigestPending = true;
};


const angularProxy = {
  active: typeof window !== 'undefined' && window.angular,
  debounceDigest(wait) {
    if (wait) {
      angularProxy.digest = _.debounce(bareDigest, wait);
    } else {
      angularProxy.digest = bareDigest;
    }
  }
};
['digest', 'watch', 'defineModule'].forEach(method => {angularProxy[method] = noop;});

if (angularProxy.active) {
  angularProxy.digest = bareDigest;
  angularProxy.watch = function() {throw new Error('Angular watch proxy not yet initialized');};
  window.angular.module('firetruss', []).run(['$rootScope', function($rootScope) {
    bareDigest = $rootScope.$evalAsync.bind($rootScope);
    if (earlyDigestPending) bareDigest();
    angularProxy.watch = $rootScope.$watch.bind($rootScope);
  }]);
  angularProxy.defineModule = function(Truss) {
    window.angular.module('firetruss').constant('Truss', Truss);
  };
}

function noop() {}

const SERVER_TIMESTAMP = Object.freeze({'.sv': 'timestamp'});

function escapeKey(key) {
  if (!key) return key;
  return key.toString().replace(/[\\\.\$\#\[\]\/]/g, function(char) {
    return '\\' + char.charCodeAt(0).toString(16);
  });
}

function unescapeKey(key) {
  if (!key) return key;
  return key.toString().replace(/\\[0-9a-f]{2}/gi, function(code) {
    return String.fromCharCode(parseInt(code.slice(1), 16));
  });
}

function wrapPromiseCallback(callback) {
  return function() {
    try {
      return Promise.resolve(callback.apply(this, arguments));
    } catch (e) {
      return Promise.reject(e);
    }
  };
}

function joinPath() {
  const segments = [];
  for (const segment of arguments) {
    if (segment.charAt(0) === '/') segments.splice(0, segments.length);
    segments.push(segment);
  }
  if (segments[0] === '/') segments[0] = '';
  return segments.join('/');
}


const pathMatchers = {};
const maxNumPathMatchers = 1000;


class PathMatcher {
  constructor(pattern) {
    this.variables = [];
    const prefixMatch = _.endsWith(pattern, '/$*');
    if (prefixMatch) pattern = pattern.slice(0, -3);
    const pathTemplate = pattern.replace(/\/\$[^\/]*/g, match => {
      if (match.length > 1) this.variables.push(match.slice(1));
      return '\u0001';
    });
    Object.freeze(this.variables);
    if (/[$-.?[-^{|}]/.test(pathTemplate)) {
      throw new Error('Path pattern has unescaped keys: ' + pattern);
    }
    this._regex = new RegExp(
      '^' + pathTemplate.replace(/\u0001/g, '/([^/]+)') + (prefixMatch ? '($|/)' : '$'));
    this._parentRegex = new RegExp(
      '^' + (pathTemplate.replace(/\/[^/]*$/, '').replace(/\u0001/g, '/([^/]+)') || '/') + '$');
  }

  match(path) {
    this._regex.lastIndex = 0;
    const match = this._regex.exec(path);
    if (!match) return;
    const bindings = {};
    for (let i = 0; i < this.variables.length; i++) {
      bindings[this.variables[i]] = unescapeKey(match[i + 1]);
    }
    return bindings;
  }

  test(path) {
    return this._regex.test(path);
  }

  testParent(path) {
    return this._parentRegex.test(path);
  }

  toString() {
    return this._regex.toString();
  }
}


function makePathMatcher(pattern) {
  let matcher = pathMatchers[pattern];
  if (!matcher) {
    matcher = new PathMatcher(pattern);
    // Minimal pseudo-LRU behavior, since we don't expect to actually fill up the cache.
    if (_.size(pathMatchers) === maxNumPathMatchers) delete pathMatchers[_.keys(pathMatchers)[0]];
    pathMatchers[pattern] = matcher;
  }
  return matcher;
}

// jshint browser:true

const MIN_WORKER_VERSION = '0.4.0';


class Snapshot {
  constructor({path, value, valueError, exists}) {
    this._path = path;
    this._value = value;
    this._valueError = errorFromJson(valueError);
    this._exists = value === undefined ? exists || false : value !== null;
  }

  get path() {
    return this._path;
  }

  get exists() {
    return this._exists;
  }

  get value() {
    this._checkValue();
    return this._value;
  }

  get key() {
    if (this._key === undefined) this._key = unescapeKey(this._path.replace(/.*\//, ''));
    return this._key;
  }

  _checkValue() {
    if (this._valueError) throw this._valueError;
    if (this._value === undefined) throw new Error('Value omitted from snapshot');
  }
}


class Bridge {
  constructor(webWorker) {
    this._idCounter = 0;
    this._deferreds = {};
    this._suspended = false;
    this._servers = {};
    this._callbacks = {};
    this._log = _.noop;
    this._simulatedTokenGenerator = null;
    this._maxSimulationDuration = 5000;
    this._simulatedCallFilter = null;
    this._inboundMessages = [];
    this._outboundMessages = [];
    this._flushMessageQueue = this._flushMessageQueue.bind(this);
    this._port = webWorker.port || webWorker;
    this._shared = !!webWorker.port;
    this._port.onmessage = this._receive.bind(this);
    window.addEventListener('unload', () => {this._send({msg: 'destroy'});});
    setInterval(() => {this._send({msg: 'ping'});}, 60 * 1000);
  }

  init(webWorker) {
    const items = [];
    try {
      const storage = window.localStorage || window.sessionStorage;
      if (!storage) return;
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        items.push({key, value: storage.getItem(key)});
      }
    } catch (e) {
      // Some browsers don't like us accessing local storage -- nothing we can do.
    }
    return this._send({msg: 'init', storage: items}).then(response => {
      const workerVersion = response.version.match(/^(\d+)\.(\d+)\.(\d+)(-.*)?$/);
      if (workerVersion) {
        const minVersion = MIN_WORKER_VERSION.match(/^(\d+)\.(\d+)\.(\d+)(-.*)?$/);
        // Major version must match precisely, minor and patch must be greater than or equal.
        const sufficient = workerVersion[1] === minVersion[1] && (
          workerVersion[2] > minVersion[2] ||
          workerVersion[2] === minVersion[2] && workerVersion[3] >= minVersion[3]
        );
        if (!sufficient) return Promise.reject(new Error(
          `Incompatible Firetruss worker version: ${response.version} ` +
          `(${MIN_WORKER_VERSION} or better required)`
        ));
      }
      return response;
    });
  }

  suspend(suspended) {
    if (suspended === undefined) suspended = true;
    if (this._suspended === suspended) return;
    this._suspended = suspended;
    if (!suspended) {
      this._receiveMessages(this._inboundMessages);
      this._inboundMessages = [];
      if (this._outboundMessages.length) Promise.resolve().then(this._flushMessageQueue);
    }
  }

  debugPermissionDeniedErrors(simulatedTokenGenerator, maxSimulationDuration, callFilter) {
    this._simulatedTokenGenerator = simulatedTokenGenerator;
    if (maxSimulationDuration !== undefined) this._maxSimulationDuration = maxSimulationDuration;
    this._simulatedCallFilter = callFilter || function() {return true;};
  }

  enableLogging(fn) {
    if (fn) {
      if (fn === true) fn = console.log.bind(console);
      this._log = fn;
    } else {
      this._log = _.noop;
    }
  }

  _send(message) {
    message.id = ++this._idCounter;
    let promise;
    if (message.oneWay) {
      promise = Promise.resolve();
    } else {
      promise = new Promise((resolve, reject) => {
        this._deferreds[message.id] = {resolve, reject};
      });
      const deferred = this._deferreds[message.id];
      deferred.promise = promise;
      promise.sent = new Promise(resolve => {
        deferred.resolveSent = resolve;
      });
      deferred.params = message;
    }
    if (!this._outboundMessages.length && !this._suspended) {
      Promise.resolve().then(this._flushMessageQueue);
    }
    this._log('send:', message);
    this._outboundMessages.push(message);
    return promise;
  }

  _flushMessageQueue() {
    this._port.postMessage(this._outboundMessages);
    this._outboundMessages = [];
  }

  _receive(event) {
    if (this._suspended) {
      this._inboundMessages = this._inboundMessages.concat(event.data);
    } else {
      this._receiveMessages(event.data);
    }
  }

  _receiveMessages(messages) {
    for (const message of messages) {
      this._log('recv:', message);
      const fn = this[message.msg];
      if (typeof fn !== 'function') throw new Error('Unknown message: ' + message.msg);
      fn.call(this, message);
    }
  }

  bindExposedFunction(name) {
    return (function() {
      return this._send({msg: 'call', name, args: Array.prototype.slice.call(arguments)});
    }).bind(this);
  }

  resolve(message) {
    const deferred = this._deferreds[message.id];
    if (!deferred) throw new Error('Received resolution to inexistent Firebase call');
    delete this._deferreds[message.id];
    deferred.resolve(message.result);
  }

  reject(message) {
    const deferred = this._deferreds[message.id];
    if (!deferred) throw new Error('Received rejection of inexistent Firebase call');
    delete this._deferreds[message.id];
    deferred.reject(errorFromJson(message.error, deferred.params));
  }

  probeError(error) {
    const code = error.code || error.message;
    if (error.params && code && code.toLowerCase() === 'permission_denied') {
      return this._simulateCall(error.params).then(securityTrace => {
        if (securityTrace) error.permissionDeniedDetails = securityTrace;
      });
    } else {
      return Promise.resolve();
    }
  }

  _simulateCall(props) {
    if (!(this._simulatedTokenGenerator && this._maxSimulationDuration > 0)) {
      return Promise.resolve();
    }
    let simulatedCalls = [];
    switch (props.msg) {
      case 'set':
        simulatedCalls.push({method: 'set', url: props.url, args: [props.value]});
        break;
      case 'update':
        simulatedCalls.push({method: 'update', url: props.url, args: [props.value]});
        break;
      case 'on':
        simulatedCalls.push({method: 'once', url: props.url, spec: props.spec, args: ['value']});
        break;
      case 'transaction':
        simulatedCalls.push({method: 'once', url: props.url, args: ['value']});
        simulatedCalls.push({method: 'set', url: props.url, args: [props.newValue]});
        break;
    }
    if (!simulatedCalls.length || !this._simulatedCallFilter(props.msg, props.url)) {
      return Promise.resolve();
    }
    const auth = this.getAuth(getUrlRoot(props.url));
    const simulationPromise = this._simulatedTokenGenerator(auth && auth.uid).then(token => {
      return Promise.all(simulatedCalls.map(message => {
        message.msg = 'simulate';
        message.token = token;
        return this._send(message);
      }));
    }).then(securityTraces => {
      if (securityTraces.every(trace => trace === null)) {
        return 'Unable to reproduce error in simulation';
      }
      return securityTraces.filter(trace => trace).join('\n\n');
    }).catch(e => {
      return 'Error running simulation: ' + e;
    });
    const timeoutPromise = new Promise(resolve => {
      setTimeout(resolve.bind(null, 'Simulated call timed out'), this._maxSimulationDuration);
    });
    return Promise.race([simulationPromise, timeoutPromise]);
  }

  updateLocalStorage(items) {
    try {
      const storage = window.localStorage || window.sessionStorage;
      for (const item in items) {
        if (item.value === null) {
          storage.removeItem(item.key);
        } else {
          storage.setItem(item.key, item.value);
        }
      }
    } catch (e) {
      // If we're denied access, there's nothing we can do.
    }
  }

  trackServer(rootUrl) {
    if (this._servers.hasOwnProperty(rootUrl)) return;
    const server = this._servers[rootUrl] = {authListeners: []};
    const authCallbackId = this._registerCallback(this._authCallback.bind(this, server));
    this._send({msg: 'onAuth', url: rootUrl, callbackId: authCallbackId});
  }

  _authCallback(server, auth) {
    server.auth = auth;
    for (const listener of server.authListeners) listener(auth);
  }

  onAuth(rootUrl, callback, context) {
    const listener = callback.bind(context);
    listener.callback = callback;
    listener.context = context;
    this._servers[rootUrl].authListeners.push(listener);
    listener(this.getAuth(rootUrl));
  }

  offAuth(rootUrl, callback, context) {
    const authListeners = this._servers[rootUrl].authListeners;
    for (let i = 0; i < authListeners.length; i++) {
      const listener = authListeners[i];
      if (listener.callback === callback && listener.context === context) {
        authListeners.splice(i, 1);
        break;
      }
    }
  }

  getAuth(rootUrl) {
    return this._servers[rootUrl].auth;
  }

  authWithCustomToken(url, authToken, options) {
    return this._send({msg: 'authWithCustomToken', url, authToken, options});
  }

  unauth(url) {
    return this._send({msg: 'unauth', url});
  }

  set(url, value, writeSerial) {return this._send({msg: 'set', url, value, writeSerial});}
  update(url, value, writeSerial) {return this._send({msg: 'update', url, value, writeSerial});}

  on(listenerKey, url, spec, eventType, snapshotCallback, cancelCallback, context, options) {
    const handle = {
      listenerKey, eventType, snapshotCallback, cancelCallback, context,
      params: {msg: 'on', listenerKey, url, spec, eventType, options}
    };
    const callback = this._onCallback.bind(this, handle);
    this._registerCallback(callback, handle);
    // Keep multiple IDs to allow the same snapshotCallback to be reused.
    snapshotCallback.__callbackIds = snapshotCallback.__callbackIds || [];
    snapshotCallback.__callbackIds.push(handle.id);
    this._send({
      msg: 'on', listenerKey, url, spec, eventType, callbackId: handle.id, options
    }).catch(error => {
      callback(error);
    });
  }

  off(listenerKey, url, spec, eventType, snapshotCallback, context) {
    const idsToDeregister = [];
    let callbackId;
    if (snapshotCallback) {
      callbackId = this._findAndRemoveCallbackId(
        snapshotCallback,
        handle =>
          handle.listenerKey === listenerKey && handle.eventType === eventType &&
          handle.context === context
      );
      if (!callbackId) return Promise.resolve();  // no-op, never registered or already deregistered
      idsToDeregister.push(callbackId);
    } else {
      for (const id of Object.keys(this._callbacks)) {
        const handle = this._callbacks[id];
        if (handle.listenerKey === listenerKey && (!eventType || handle.eventType === eventType)) {
          idsToDeregister.push(id);
        }
      }
    }
    // Nullify callbacks first, then deregister after off() is complete.  We don't want any
    // callbacks in flight from the worker to be invoked while the off() is processing, but we don't
    // want them to throw an exception either.
    for (const id of idsToDeregister) this._nullifyCallback(id);
    return this._send({msg: 'off', listenerKey, url, spec, eventType, callbackId}).then(() => {
      for (const id of idsToDeregister) this._deregisterCallback(id);
    });
  }

  _onCallback(handle, error, snapshotJson) {
    if (error) {
      this._deregisterCallback(handle.id);
      const e = errorFromJson(error, handle.params);
      if (handle.cancelCallback) {
        handle.cancelCallback.call(handle.context, e);
      } else {
        console.error(e);
      }
    } else {
      handle.snapshotCallback.call(handle.context, new Snapshot(snapshotJson));
    }
  }

  transaction(url, oldValue, relativeUpdates) {
    return this._send({msg: 'transaction', url, oldValue, relativeUpdates});
  }

  onDisconnect(url, method, value) {
    return this._send({msg: 'onDisconnect', url, method, value});
  }

  bounceConnection() {
    return this._send({msg: 'bounceConnection'});
  }

  callback({id, args}) {
    const handle = this._callbacks[id];
    if (!handle) throw new Error('Unregistered callback: ' + id);
    handle.callback.apply(null, args);
  }

  _registerCallback(callback, handle) {
    handle = handle || {};
    handle.callback = callback;
    handle.id = `cb${++this._idCounter}`;
    this._callbacks[handle.id] = handle;
    return handle.id;
  }

  _nullifyCallback(id) {
    this._callbacks[id].callback = noop$1;
  }

  _deregisterCallback(id) {
    delete this._callbacks[id];
  }

  _findAndRemoveCallbackId(callback, predicate) {
    if (!callback.__callbackIds) return;
    let i = 0;
    while (i < callback.__callbackIds.length) {
      const id = callback.__callbackIds[i];
      const handle = this._callbacks[id];
      if (!handle) {
        callback.__callbackIds.splice(i, 1);
        continue;
      }
      if (predicate(handle)) {
        callback.__callbackIds.splice(i, 1);
        return id;
      }
      i += 1;
    }
  }
}


function noop$1() {}

function errorFromJson(json, params) {
  if (!json || json instanceof Error) return json;
  const error = new Error(json.message);
  error.params = params;
  for (const propertyName in json) {
    if (propertyName === 'message' || !json.hasOwnProperty(propertyName)) continue;
    try {
      error[propertyName] = json[propertyName];
    } catch (e) {
      e.extra = {propertyName};
      throw e;
    }
  }
  return error;
}

function getUrlRoot(url) {
  const k = url.indexOf('/', 8);
  return k >= 8 ? url.slice(0, k) : url;
}

const EMPTY_ANNOTATIONS = {};
Object.freeze(EMPTY_ANNOTATIONS);


class Handle {
  constructor(tree, path, annotations) {
    this._tree = tree;
    this._path = path.replace(/^\/*/, '/').replace(/\/$/, '');
    if (annotations) {
      this._annotations = annotations;
      Object.freeze(annotations);
    }
  }

  get $ref() {return this;}
  get key() {
    if (!this._key) this._key = unescapeKey(this._path.replace(/.*\//, ''));
    return this._key;
  }
  get path() {return this._path;}
  get _pathPrefix() {return this._path === '/' ? '' : this._path;}
  get parent() {
    return new Reference(this._tree, this._path.replace(/\/[^/]*$/, ''), this._annotations);
  }

  get annotations() {
    return this._annotations || EMPTY_ANNOTATIONS;
  }

  child() {
    if (!arguments.length) return this;
    const segments = [];
    for (const key of arguments) {
      if (key === undefined || key === null) return;
      segments.push(escapeKey(key));
    }
    return new Reference(
      this._tree, `${this._pathPrefix}/${segments.join('/')}`,
      this._annotations
    );
  }

  children() {
    if (!arguments.length) return this;
    const escapedKeys = [];
    for (let i = 0; i < arguments.length; i++) {
      const arg = arguments[i];
      if (_.isArray(arg)) {
        const mapping = {};
        const subPath = `${this._pathPrefix}/${escapedKeys.join('/')}`;
        const rest = _.slice(arguments, i + 1);
        for (const key of arg) {
          const subRef =
            new Reference(this._tree, `${subPath}/${escapeKey(key)}`, this._annotations);
          const subMapping = subRef.children.apply(subRef, rest);
          if (subMapping) mapping[key] = subMapping;
        }
        if (_.isEmpty(mapping)) return;
        return mapping;
      } else {
        if (arg === undefined || arg === null) return;
        escapedKeys.push(escapeKey(arg));
      }
    }
    return new Reference(
      this._tree, `${this._pathPrefix}/${escapedKeys.join('/')}`, this._annotations);
  }

  peek(callback) {
    return this._tree.truss.peek(this, callback);
  }

  match(pattern) {
    return makePathMatcher(pattern).match(this.path);
  }

  isEqual(that) {
    if (!(that instanceof Handle)) return false;
    return this._tree === that._tree && this.toString() === that.toString();
  }

  belongsTo(truss) {
    return this._tree.truss === truss;
  }
}


class Query extends Handle {
  constructor(tree, path, spec, annotations) {
    super(tree, path, annotations);
    this._spec = this._copyAndValidateSpec(spec);
  }

  // Vue-bound
  get ready() {
    return this._tree.isQueryReady(this);
  }

  get constraints() {
    return this._spec;
  }

  annotate(annotations) {
    return new Query(
      this._tree, this._path, this._spec, _.extend({}, this._annotations, annotations));
  }

  _copyAndValidateSpec(spec) {
    if (!spec.by) throw new Error('Query needs "by" clause: ' + JSON.stringify(spec));
    if (('at' in spec) + ('from' in spec) + ('to' in spec) > 1) {
      throw new Error(
        'Query must contain at most one of "at", "from", or "to" clauses: ' + JSON.stringify(spec));
    }
    if (('first' in spec) + ('last' in spec) > 1) {
      throw new Error(
        'Query must contain at most one of "first" or "last" clauses: ' + JSON.stringify(spec));
    }
    if (!_.some(['at', 'from', 'to', 'first', 'last'], clause => clause in spec)) {
      throw new Error(
        'Query must contain at least one of "at", "from", "to", "first", or "last" clauses: ' +
        JSON.stringify(spec));
    }
    spec = _.clone(spec);
    if (spec.by !== '$key' && spec.by !== '$value') {
      if (!(spec.by instanceof Reference)) {
        throw new Error('Query "by" value must be a reference: ' + spec.by);
      }
      let childPath = spec.by.toString();
      if (!_.startsWith(childPath, this._path)) {
        throw new Error(
          'Query "by" value must be a descendant of target reference: ' + spec.by);
      }
      childPath = childPath.slice(this._path.length).replace(/^\/?/, '');
      if (childPath.indexOf('/') === -1) {
        throw new Error(
          'Query "by" value must not be a direct child of target reference: ' + spec.by);
      }
      spec.by = childPath.replace(/.*?\//, '');
    }
    Object.freeze(spec);
    return spec;
  }


  toString() {
    if (!this._string) {
      const queryTerms = _(this._spec)
        .map((value, key) => `${key}=${encodeURIComponent(JSON.stringify(value))}`)
        .sortBy()
        .join('&');
      this._string = `${this._path}?${queryTerms}`;
    }
    return this._string;
  }
}


// jshint latedef:false
class Reference extends Handle {
// jshint latedef:nofunc

  constructor(tree, path, annotations) {
    super(tree, path, annotations);
  }

  get ready() {return this._tree.isReferenceReady(this);}  // Vue-bound
  get value() {return this._tree.getObject(this.path);}  // Vue-bound
  toString() {return this._path;}

  annotate(annotations) {
    return new Reference(this._tree, this._path, _.extend({}, this._annotations, annotations));
  }

  query(spec) {
    return new Query(this._tree, this._path, spec);
  }

  set(value) {
    return this._tree.update(this, 'set', {[this.path]: value});
  }

  update(values) {
    return this._tree.update(this, 'update', values);
  }

  override(value) {
    return this._tree.update(this, 'override', {[this.path]: value});
  }

  commit(updateFunction) {
    return this._tree.commit(this, updateFunction);
  }
}

class Connector {
  constructor(scope, connections, tree, method, refs) {
    Object.freeze(connections);
    this._scope = scope;
    this._connections = connections;
    this._tree = tree;
    this._method = method;
    this._refs = refs || {};
    this._subConnectors = {};
    this._currentDescriptors = {};
    this._disconnects = {};
    this._vue = new Vue({data: _.mapValues(connections, _.constant(undefined))});

    this._linkScopeProperties();

    _.each(connections, (descriptor, key) => {
      if (_.isFunction(descriptor)) {
        this._bindComputedConnection(key, descriptor);
      } else {
        this._connect(key, descriptor);
      }
    });

    if (angularProxy.active && scope && scope.$on && scope.$id) {
      scope.$on('$destroy', () => {this.destroy();});
    }
  }

  get ready() {
    return _.every(this._currentDescriptors, (descriptor, key) => {
      if (!descriptor) return false;
      if (descriptor instanceof Handle) return descriptor.ready;
      return this._subConnectors[key].ready;
    });
  }

  get at() {
    return this._refs;
  }

  destroy() {
    this._unlinkScopeProperties();
    _.each(this._angularUnwatches, unwatch => {unwatch();});
    _.each(this._connections, (descriptor, key) => {this._disconnect(key);});
    this._vue.$destroy();
  }

  _linkScopeProperties() {
    if (!this._scope) return;
    for (const key in this._connections) {
      if (key in this._scope) {
        throw new Error(`Property already defined on connection target: ${key}`);
      }
    }
    Object.defineProperties(this._scope, _.mapValues(this._connections, (descriptor, key) => ({
      configurable: true, enumerable: true, get: () => this._vue[key]
    })));
  }

  _unlinkScopeProperties() {
    if (!this._scope) return;
    _.each(this._connections, (descriptor, key) => {
      delete this._scope[key];
    });
  }

  _bindComputedConnection(key, fn) {
    const getter = this._computeConnection.bind(this, fn);
    const update = this._updateComputedConnection.bind(this, key, fn);
    // Use this._vue.$watch instead of truss.watch here so that we can disable the immediate
    // callback if we'll get one from Angular anyway.
    this._vue.$watch(getter, update, {immediate: !angularProxy.active, deep: true});
    if (angularProxy.active) {
      if (!this._angularUnwatches) this._angularUnwatches = [];
      this._angularUnwatches.push(angularProxy.watch(getter, update, true));
    }
  }

  _computeConnection(fn) {
    return flattenRefs(fn.call(this._scope));
  }

  _updateComputedConnection(key, value) {
    const newDescriptor = _.isFunction(value) ? value(this._scope) : value;
    const oldDescriptor = this._currentDescriptors[key];
    if (oldDescriptor === newDescriptor ||
        newDescriptor instanceof Handle && newDescriptor.isEqual(oldDescriptor)) return;
    if (!newDescriptor) {
      this._disconnect(key);
      return;
    }
    if (newDescriptor instanceof Handle || !_.has(this._subConnectors, key)) {
      this._disconnect(key);
      this._connect(key, newDescriptor);
    } else {
      this._subConnectors[key]._updateConnections(newDescriptor);
    }
    this._currentDescriptors[key] = newDescriptor;
  }

  _updateConnections(connections) {
    _.each(connections, (descriptor, key) => {
      this._updateComputedConnection(key, descriptor);
    });
    _.each(this._connections, (descriptor, key) => {
      if (!_.has(connections, key)) this._updateComputedConnection(key);
    });
    this._connections = connections;
  }

  _connect(key, descriptor) {
    this._currentDescriptors[key] = descriptor;
    if (!descriptor) return;
    if (descriptor instanceof Reference) {
      this._refs[key] = descriptor;
      const updateFn = this._scope ? this._updateScopeRef.bind(this, key) : null;
      this._disconnects[key] = this._tree.connectReference(descriptor, updateFn, this._method);
    } else if (descriptor instanceof Query) {
      this._refs[key] = descriptor;
      const updateFn = this._scope ? this._updateScopeQuery.bind(this, key) : null;
      this._disconnects[key] = this._tree.connectQuery(descriptor, updateFn, this._method);
    } else {
      const subScope = {}, subRefs = {};
      this._refs[key] = subRefs;
      const subConnector = this._subConnectors[key] =
        new Connector(subScope, descriptor, this._tree, this._method, subRefs);
      if (this._scope) {
        // Use a truss.watch here instead of this._vue.$watch so that the "immediate" execution
        // actually takes place after we've captured the unwatch function, in case the subConnector
        // is ready immediately.
        const unwatch = this._disconnects[key] = this._tree.truss.watch(
          () => subConnector.ready,
          subReady => {
            if (!subReady) return;
            unwatch();
            delete this._disconnects[key];
            Vue.set(this._vue, key, subScope);
            angularProxy.digest();
          }
        );
      }
    }
  }

  _disconnect(key) {
    delete this._refs[key];
    if (this._scope) this._updateScopeRef(key, undefined);
    if (_.has(this._subConnectors, key)) {
      this._subConnectors[key].destroy();
      delete this._subConnectors[key];
    }
    if (this._disconnects[key]) this._disconnects[key]();
    delete this._disconnects[key];
    delete this._currentDescriptors[key];
  }

  _updateScopeRef(key, value) {
    if (this._vue[key] !== value) {
      Vue.set(this._vue, key, value);
      angularProxy.digest();
    }
  }

  _updateScopeQuery(key, childKeys) {
    let changed = false;
    if (!this._vue[key]) {
      Vue.set(this._vue, key, {});
      changed = true;
    }
    const subScope = this._vue[key];
    for (const childKey in subScope) {
      if (!subScope.hasOwnProperty(childKey)) continue;
      if (!_.contains(childKeys, childKey)) {
        Vue.delete(subScope, childKey);
        changed = true;
      }
    }
    let object;
    for (const segment of this._currentDescriptors[key].path.split('/')) {
      object = segment ? object[segment] : this._tree.root;
    }
    for (const childKey of childKeys) {
      if (subScope.hasOwnProperty(childKey)) continue;
      Vue.set(subScope, childKey, object[childKey]);
      changed = true;
    }
    if (changed) angularProxy.digest();
  }

}

function flattenRefs(refs) {
  if (!refs) return;
  if (refs instanceof Handle) return refs.toString();
  return _.mapValues(refs, flattenRefs);
}

const INTERCEPT_KEYS = [
  'read', 'write', 'auth', 'set', 'update', 'commit', 'connect', 'peek', 'all'
];

const EMPTY_ARRAY = [];


class SlowHandle {
  constructor(operation, delay, callback) {
    this._operation = operation;
    this._delay = delay;
    this._callback = callback;
    this._fired = false;
  }

  initiate() {
    this.cancel();
    this._fired = false;
    const elapsed = Date.now() - this._operation._startTimestamp;
    this._timeoutId = setTimeout(this._delay - elapsed, () => {
      this._fired = true;
      this._callback(this._operation);
    });
  }

  cancel() {
    if (this._fired) this._callback(this._operation);
    if (this._timeoutId) clearTimeout(this._timeoutId);
  }
}


class Operation {
  constructor(type, method, target) {
    this._type = type;
    this._method = method;
    this._target = target;
    this._ready = false;
    this._running = false;
    this._ended = false;
    this._tries = 0;
    this._startTimestamp = Date.now();
    this._slowHandles = [];
  }

  get type() {return this._type;}
  get method() {return this._method;}
  get target() {return this._target;}
  get ready() {return this._ready;}
  get running() {return this._running;}
  get ended() {return this._ended;}
  get tries() {return this._tries;}
  get error() {return this._error;}

  onSlow(delay, callback) {
    const handle = new SlowHandle(this, delay, callback);
    this._slowHandles.push(handle);
    handle.initiate();
  }

  _setRunning(value) {
    this._running = value;
  }

  _setEnded(value) {
    this._ended = value;
  }

  _markReady() {
    this._ready = true;
    this._tries = 0;
    _.each(this._slowHandles, handle => handle.cancel());
  }

  _clearReady() {
    this._ready = false;
    this._startTimestamp = Date.now();
    _.each(this._slowHandles, handle => handle.initiate());
  }

  _incrementTries() {
    this._tries++;
  }
}


class Dispatcher {
  constructor(bridge) {
    this._bridge = bridge;
    this._callbacks = {};
  }

  intercept(interceptKey, callbacks) {
    if (!_.contains(INTERCEPT_KEYS, interceptKey)) {
      throw new Error('Unknown intercept operation type: ' + interceptKey);
    }
    const badCallbackKeys =
      _.difference(_.keys(callbacks), ['onBefore', 'onAfter', 'onError', 'onFailure']);
    if (badCallbackKeys.length) {
      throw new Error('Unknown intercept callback types: ' + badCallbackKeys.join(', '));
    }
    const wrappedCallbacks = {
      onBefore: this._addCallback('onBefore', interceptKey, callbacks.onBefore),
      onAfter: this._addCallback('onAfter', interceptKey, callbacks.onAfter),
      onError: this._addCallback('onError', interceptKey, callbacks.onError),
      onFailure: this._addCallback('onFailure', interceptKey, callbacks.onFailure)
    };
    return this._removeCallbacks.bind(this, interceptKey, wrappedCallbacks);
  }

  _addCallback(stage, interceptKey, callback) {
    if (!callback) return;
    const key = this._getCallbacksKey(stage, interceptKey);
    const wrappedCallback = wrapPromiseCallback(callback);
    (this._callbacks[key] || (this._callbacks[key] = [])).push(wrappedCallback);
    return wrappedCallback;
  }

  _removeCallback(stage, interceptKey, wrappedCallback) {
    if (!wrappedCallback) return;
    const key = this._getCallbacksKey(stage, interceptKey);
    if (this._callbacks[key]) _.pull(this._callbacks[key], wrappedCallback);
  }

  _removeCallbacks(interceptKey, wrappedCallbacks) {
    _.each(wrappedCallbacks, (wrappedCallback, stage) => {
      this._removeCallback(stage, interceptKey, wrappedCallback);
    });
  }

  _getCallbacks(stage, operationType, method) {
    return [].concat(
      this._callbacks[this._getCallbacksKey(stage, method)] || EMPTY_ARRAY,
      this._callbacks[this._getCallbacksKey(stage, operationType)] || EMPTY_ARRAY,
      this._callbacks[this._getCallbacksKey(stage, 'all')] || EMPTY_ARRAY
    );
  }

  _getCallbacksKey(stage, interceptKey) {
    return `${stage}_${interceptKey}`;
  }

  execute(operationType, method, target, executor) {
    executor = wrapPromiseCallback(executor);
    const operation = this.createOperation(operationType, method, target);
    return this.begin(operation).then(() => {
      const executeWithRetries = () => {
        return executor().catch(e => this._retryOrEnd(operation, e).then(executeWithRetries));
      };
      return executeWithRetries();
    }).then(result => this.end(operation).then(() => result));
  }

  createOperation(operationType, method, target) {
    return new Operation(operationType, method, target);
  }

  begin(operation) {
    return Promise.all(_.map(
      this._getCallbacks('onBefore', operation.type, operation.method),
      onBefore => onBefore(operation)
    )).then(() => {
      if (!operation.ended) operation._setRunning(true);
    }, e => this.end(operation, e));
  }

  markReady(operation) {
    operation._markReady();
  }

  clearReady(operation) {
    operation._clearReady();
  }

  retry(operation, error) {
    operation._incrementTries();
    operation._error = error;
    return Promise.all(_.map(
      this._getCallbacks('onError', operation.type, operation.method),
      onError => onError(operation, error)
    )).then(results => {
      const retrying = _.some(results);
      if (retrying) delete operation._error;
      return retrying;
    });
  }

  _retryOrEnd(operation, error) {
    return this.retry(operation, error).then(result => {
      if (!result) return this.end(operation, error);
    }, e => this.end(operation, e));
  }

  end(operation, error) {
    if (operation.ended) return;
    operation._setRunning(false);
    operation._setEnded(true);
    if (error) operation._error = error;
    return Promise.all(_.map(
      this._getCallbacks('onAfter', operation.type, operation.method),
      onAfter => onAfter(operation)
    )).then(
      () => this._afterEnd(operation),
      e => {
        operation._error = e;
        return this._afterEnd(operation);
      }
    );
  }

  _afterEnd(operation) {
    this.markReady(operation);
    if (operation.error) {
      const onFailureCallbacks = this._getCallbacks('onFailure', operation.type, operation.method);
      return this._bridge.probeError(operation.error).then(() => {
        if (onFailureCallbacks) {
          setTimeout(() => {
            _.each(onFailureCallbacks, onFailure => onFailure(operation));
          }, 0);
        }
        return Promise.reject(operation.error);
      });
    }
  }
}

const ALPHABET = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

class KeyGenerator {
  constructor() {
    this._lastUniqueKeyTime = 0;
    this._lastRandomValues = [];
  }

  generateUniqueKey(now) {
    now = now || Date.now();
    const chars = new Array(20);
    let prefix = now;
    for (let i = 7; i >= 0; i--) {
      chars[i] = ALPHABET.charAt(prefix & 0x3f);
      prefix = Math.floor(prefix / 64);
    }
    if (now === this._lastUniqueKeyTime) {
      let i = 11;
      while (i >= 0 && this._lastRandomValues[i] === 63) {
        this._lastRandomValues[i] = 0;
        i -= 1;
      }
      if (i === -1) {
        throw new Error('Internal assertion failure: ran out of unique IDs for this millisecond');
      }
      this._lastRandomValues[i] += 1;
    } else {
      this._lastUniqueKeyTime = now;
      for (let i = 0; i < 12; i++) {
        // Make sure to leave some space for incrementing in the top nibble.
        this._lastRandomValues[i] = Math.floor(Math.random() * (i ? 64 : 16));
      }
    }
    for (let i = 0; i < 12; i++) {
      chars[i + 8] = ALPHABET[this._lastRandomValues[i]];
    }
    return chars.join('');
  }
}

class MetaTree {
  constructor(rootUrl, bridge) {
    this._rootUrl = rootUrl;
    this._bridge = bridge;
    this._vue = new Vue({data: {$root: {
      connected: undefined, timeOffset: 0, user: undefined, userid: undefined,
      updateNowAtIntervals(name, intervalMillis) {
        if (this.hasOwnProperty(name)) throw new Error(`Property "${name}" already defined`);
        Vue.set(this, name, Date.now() + this.timeOffset);
        setInterval(() => {
          this[name] = Date.now() + this.timeOffset;
        }, intervalMillis);
      }
    }}});

    if (angularProxy.active) {
      this._vue.$watch('$data', angularProxy.digest, {deep: true});
    }

    bridge.onAuth(rootUrl, this._handleAuthChange, this);

    this._connectInfoProperty('serverTimeOffset', 'timeOffset');
    this._connectInfoProperty('connected', 'connected');
  }

  get root() {
    return this._vue.$data.$root;
  }

  destroy() {
    this._bridge.offAuth(this._rootUrl, this._handleAuthChange, this);
    this._vue.$destroy();
  }

  _handleAuthChange(user) {
    this.root.user = user;
    this.root.userid = user && user.uid;
  }

  _connectInfoProperty(property, attribute) {
    const propertyUrl = `${this._rootUrl}/.info/${property}`;
    this._bridge.on(propertyUrl, propertyUrl, null, 'value', snap => {
      this.root[attribute] = snap.value;
    });
  }
}

class QueryHandler {
  constructor(coupler, query) {
    this._coupler = coupler;
    this._query = query;
    this._listeners = [];
    this._keys = [];
    this._url = this._coupler._rootUrl + query.path;
    this._segments = query.path.split('/');
    this._listening = false;
    this.ready = false;
  }

  attach(operation, keysCallback) {
    this._listen();
    this._listeners.push({operation, keysCallback});
    keysCallback(this._keys);
  }

  detach(operation) {
    const k = _.findIndex(this._listeners, {operation});
    if (k >= 0) this._listeners.splice(k, 1);
    return this._listeners.length;
  }

  _listen() {
    if (this._listening) return;
    this._coupler._bridge.on(
      this._query.toString(), this._url, this._query.constraints, 'value',
      this._handleSnapshot, this._handleError.bind(this._query.path), this, {sync: true});
    this._listening = true;
  }

  destroy() {
    this._coupler._bridge.off(
      this._query.toString(), this._url, this._query.constraints, 'value', this._handleSnapshot,
      this);
    this._listening = false;
    this.ready = false;
    angularProxy.digest();
    for (const key of this._keys) {
      this._coupler._decoupleSegments(this._segments.concat(key));
    }
  }

  _handleSnapshot(snap) {
    // Order is important here: first couple any new subpaths so _handleSnapshot will update the
    // tree, then tell the client to update its keys, pulling values from the tree.
    if (!this._listeners.length || !this._listening) return;
    const updatedKeys = this._updateKeys(snap);
    this._coupler._applySnapshot(snap);
    if (!this.ready) {
      this.ready = true;
      angularProxy.digest();
      for (const listener of this._listeners) {
        this._coupler._dispatcher.markReady(listener.operation);
      }
    }
    if (updatedKeys) {
      for (const listener of this._listeners) listener.keysCallback(updatedKeys);
    }
  }

  _updateKeys(snap) {
    let updatedKeys;
    if (snap.path === this._query.path) {
      updatedKeys = _.keys(snap.value);
      updatedKeys.sort();
      if (_.isEqual(this._keys, updatedKeys)) {
        updatedKeys = null;
      } else {
        for (const key of _.difference(updatedKeys, this._keys)) {
          this._coupler._coupleSegments(this._segments.concat(key));
        }
        for (const key of _.difference(this._keys, updatedKeys)) {
          this._coupler._decoupleSegments(this._segments.concat(key));
        }
        this._keys = updatedKeys;
      }
    } else if (snap.path.replace(/\/[^/]+/, '') === this._query.path) {
      const hasKey = _.contains(this._keys, snap.key);
      if (snap.value) {
        if (!hasKey) {
          this._coupler._coupleSegments(this._segments.concat(snap.key));
          this._keys.push(snap.key);
          this._keys.sort();
          updatedKeys = this._keys;
        }
      } else {
        if (hasKey) {
          this._coupler._decoupleSegments(this._segments.concat(snap.key));
          _.pull(this._keys, snap.key);
          this._keys.sort();
          updatedKeys = this._keys;
        }
      }
    }
    return updatedKeys;
  }

  _handleError(error) {
    if (!this._listeners.length || !this._listening) return;
    this._listening = false;
    Promise.all(_.map(this._listeners, listener => {
      this._coupler._dispatcher.clearReady(listener.operation);
      return this._coupler._dispatcher.retry(listener.operation, error).catch(e => {
        listener.operation._disconnect(e);
        return false;
      });
    })).then(results => {
      if (_.some(results)) {
        if (this._listeners.length) this._listen();
      } else {
        for (const listener of this._listeners) listener.operation._disconnect(error);
      }
    });
  }
}


class Node {
  constructor(coupler, path) {
    this._coupler = coupler;
    this.path = path;
    this.url = this._coupler._rootUrl + path;
    this.operations = [];
    this.queryCount = 0;
    this.listening = false;
    this.ready = false;
    this.children = {};
  }

  get active() {
    return this.count || this.queryCount;
  }

  get count() {
    return this.operations.length;
  }

  listen(skip) {
    if (!skip && this.count) {
      if (this.listening) return;
      _.each(this.operations, op => {this._coupler._dispatcher.clearReady(op);});
      this._coupler._bridge.on(
        this.url, this.url, null, 'value', this._handleSnapshot, this._handleError.bind(this),
        this, {sync: true});
      this.listening = true;
    } else {
      _.each(this.children, child => {child.listen();});
    }
  }

  unlisten(skip) {
    if (!skip && this.listening) {
      this._coupler._bridge.off(this.url, this.url, null, 'value', this._handleSnapshot, this);
      this.listening = false;
      this._forAllDescendants(node => {
        if (node.ready) {
          node.ready = false;
          angularProxy.digest();
        }
      });
    } else {
      _.each(this.children, child => {child.unlisten();});
    }
  }

  _handleSnapshot(snap) {
    if (!this.listening || !this._coupler.isTrunkCoupled(snap.path)) return;
    this._coupler._applySnapshot(snap);
    if (!this.ready && snap.path === this.path) {
      this.ready = true;
      angularProxy.digest();
      this.unlisten(true);
      this._forAllDescendants(node => {
        for (const op of this.operations) this._coupler._dispatcher.markReady(op);
      });
    }
  }

  _handleError(error) {
    if (!this.count || !this.listening) return;
    this.listening = false;
    this._forAllDescendants(node => {
      if (node.ready) {
        node.ready = false;
        angularProxy.digest();
      }
      for (const op of this.operations) this._coupler._dispatcher.clearReady(op);
    });
    return Promise.all(_.map(this.operations, op => {
      return this._coupler._dispatcher.retry(op, error).catch(e => {
        op._disconnect(e);
        return false;
      });
    })).then(results => {
      if (_.some(results)) {
        if (this.count) this.listen();
      } else {
        for (const op of this.operations) op._disconnect(error);
        // Pulling all the operations will automatically get us listening on descendants.
      }
    });
  }

  _forAllDescendants(iteratee) {
    iteratee(this);
    _.each(this.children, child => child._forAllDescendants(iteratee));
  }

  collectCoupledDescendantPaths(paths) {
    if (!paths) paths = {};
    paths[this.path] = this.active;
    if (!this.active) {
      _.each(this.children, child => {child.collectCoupledDescendantPaths(paths);});
    }
    return paths;
  }
}


class Coupler {
  constructor(rootUrl, bridge, dispatcher, applySnapshot, prunePath) {
    this._rootUrl = rootUrl;
    this._bridge = bridge;
    this._dispatcher = dispatcher;
    this._applySnapshot = applySnapshot;
    this._prunePath = prunePath;
    this._vue = new Vue({data: {root: new Node(this, '/'), queryHandlers: {}}});
  }

  get _root() {return this._vue.root;}
  get _queryHandlers() {return this._vue.queryHandlers;}

  destroy() {
    _.each(this._queryHandlers, queryHandler => {queryHandler.destroy();});
    this._root.unlisten();
    this._vue.$destroy();
  }

  couple(path, operation) {
    return this._coupleSegments(path.split('/'), operation);
  }

  _coupleSegments(segments, operation) {
    let node;
    let superseded = !operation;
    let ready = false;
    for (const segment of segments) {
      let child = segment ? node.children && node.children[segment] : this._root;
      if (!child) {
        child = new Node(this, `${node.path === '/' ? '' : node.path}/${segment}`);
        Vue.set(node.children, segment, child);
      }
      superseded = superseded || child.listening;
      ready = ready || child.ready;
      node = child;
    }
    if (operation) {
      node.operations.push(operation);
    } else {
      node.queryCount++;
    }
    if (superseded) {
      if (operation && ready) this._dispatcher.markReady(operation);
    } else {
      node.listen();  // node will call unlisten() on descendants when ready
    }
  }

  decouple(path, operation) {
    return this._decoupleSegments(path.split('/'), operation);
  }

  _decoupleSegments(segments, operation) {
    const ancestors = [];
    let node;
    for (const segment of segments) {
      node = segment ? node.children && node.children[segment] : this._root;
      if (!node) break;
      ancestors.push(node);
    }
    if (!node || !(operation ? node.count : node.queryCount)) {
      throw new Error(`Path not coupled: ${segments.join('/')}`);
    }
    if (operation) {
      _.pull(node.operations, operation);
    } else {
      node.queryCount--;
    }
    if (operation && !node.count) {
      // Ideally, we wouldn't resync the full values here since we probably already have the current
      // value for all children.  But making sure that's true is tricky in an async system (what if
      // the node's value changes and the update crosses the 'off' call in transit?) and this
      // situation should be sufficiently rare that the optimization is probably not worth it right
      // now.
      node.listen();
      if (node.listening) node.unlisten();
    }
    if (!node.active) {
      for (let i = ancestors.length - 1; i > 0; i--) {
        node = ancestors[i];
        if (node === this._root || node.active || !_.isEmpty(node.children)) break;
        Vue.delete(ancestors[i - 1].children, segments[i]);
      }
      this._prunePath(segments.join('/'), this.findCoupledDescendantPaths(segments));
    }
  }

  subscribe(query, operation, keysCallback) {
    let queryHandler = this._queryHandlers[query.toString()];
    if (!queryHandler) {
      queryHandler = new QueryHandler(this, query);
      Vue.set(this._queryHandlers, query.toString(), queryHandler);
    }
    queryHandler.attach(operation, keysCallback);
 }

  unsubscribe(query, operation) {
    const queryHandler = this._queryHandlers[query.toString()];
    if (queryHandler && !queryHandler.detach(operation)) {
      queryHandler.destroy();
      Vue.delete(this._queryHandlers, query.toString());
    }
  }

  // Return whether the node at path or any ancestors are coupled.
  isTrunkCoupled(path) {
    const segments = path.split('/');
    let node;
    for (const segment of segments) {
      node = segment ? node.children && node.children[segment] : this._root;
      if (!node) return false;
      if (node.active) return true;
    }
    return false;
  }

  findCoupledDescendantPaths(pathOrSegments) {
    const segments = _.isString(pathOrSegments) ? pathOrSegments.split('/') : pathOrSegments;
    let node;
    for (const segment of segments) {
      node = segment ? node.children && node.children[segment] : this._root;
      if (!node) break;
    }
    return node && node.collectCoupledDescendantPaths();
  }

  isSubtreeReady(path) {
    const segments = path.split('/');
    let node;
    for (const segment of segments) {
      node = segment ? node.children && node.children[segment] : this._root;
      if (!node) return false;
      if (node.ready) return true;
    }
    return false;
  }

  isQueryReady(query) {
    const queryHandler = this._queryHandlers[query.toString()];
    return queryHandler && queryHandler.ready;
  }

}

// These are defined separately for each object so they're not included in Value below.
const RESERVED_VALUE_PROPERTY_NAMES = {
  $truss: true, $parent: true, $key: true, $path: true, $ref: true,
  $$touchThis: true, $$initializers: true, $$finalizers: true,
  __ob__: true
};

const computedPropertyStats = {};


class Value {
  get $truss() {
    Object.defineProperty(this, '$truss', {value: this.$parent.$truss});
    return this.$truss;
  }
  get $ref() {
    Object.defineProperty(this, '$ref', {value: new Reference(this.$truss._tree, this.$path)});
    return this.$ref;
  }
  get $refs() {return this.$ref;}
  get $key() {
    Object.defineProperty(
      this, '$key', {value: unescapeKey(this.$path.slice(this.$path.lastIndexOf('/') + 1))});
    return this.$key;
  }
  get $keys() {return _.keys(this);}
  get $values() {return _.values(this);}
  get $root() {return this.$truss.root;}  // access indirectly to leave dependency trace
  get $ready() {return this.$ref.ready;}
  get $overridden() {return false;}

  $watch(subjectFn, callbackFn, options) {
    let unwatchAndRemoveDestructor;

    const unwatch = this.$truss.watch(() => {
      this.$$touchThis();
      return subjectFn.call(this);
    }, callbackFn.bind(this), options);

    unwatchAndRemoveDestructor = () => {
      unwatch();
      _.pull(this.$$finalizers, unwatchAndRemoveDestructor);
    };
    this.$$finalizers.push(unwatchAndRemoveDestructor);
    return unwatchAndRemoveDestructor;
  }

  $when(expression, options) {
    const promise = this.$truss.when(() => {
      this.$$touchThis();
      return expression.call(this);
    }, options);

    const originalCancel = promise.cancel;
    promise.cancel = () => {
      originalCancel();
      _.pull(this.$$finalizers, promise.cancel);
    };
    this.$$finalizers.push(promise.cancel);
    return promise;
  }

  $set(value) {return this.$ref.set(value);}
  $update(values) {return this.$ref.update(values);}
  $override(values) {return this.$ref.override(values);}
  $commit(options, updateFn) {return this.$ref.commit(options, updateFn);}

  $$touchThis() {
    // jshint expr:true
    if (this.$parent) this.$parent[this.$key]; else this.$root;
    // jshint expr:false
  }

  get $$finalizers() {
    Object.defineProperty(this, '$$finalizers', {
      value: [], writable: false, enumerable: false, configurable: false});
    return this.$$finalizers;
  }
}

class ComputedPropertyStats {
  constructor(name) {
    _.extend(this, {name, numRecomputes: 0, numUpdates: 0, runtime: 0});
  }
}

class ErrorWrapper {
  constructor(error) {
    this.error = error;
  }
}


class Modeler {
  constructor(classes) {
    this._mounts = _(classes).uniq().map(Class => this._mountClass(Class)).flatten().value();
    const patterns = _.map(this._mounts, mount => mount.matcher.toString());
    if (patterns.length !== _.uniq(patterns).length) {
      const badPaths = _(patterns)
        .groupBy()
        .map((group, key) =>
          group.length === 1 ? null : key.replace(/\(\[\^\/\]\+\)/g, '$').slice(1, -1))
        .compact()
        .value();
      throw new Error('Paths have multiple mounted classes: ' + badPaths.join(', '));
    }
  }

  destroy() {
  }

  _augmentClass(Class) {
    let computedProperties;
    let proto = Class.prototype;
    while (proto && proto.constructor !== Object) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (name.charAt(0) === '$') {
          if (_.isEqual(descriptor, Object.getOwnPropertyDescriptor(Value.prototype, name))) {
            continue;
          }
          throw new Error(`Property names starting with "$" are reserved: ${Class.name}.${name}`);
        }
        if (descriptor.set) {
          throw new Error(`Computed properties must not have a setter: ${Class.name}.${name}`);
        }
        if (descriptor.get && !(computedProperties && computedProperties[name])) {
          (computedProperties || (computedProperties = {}))[name] = {
            name, fullName: `${proto.constructor.name}.${name}`, get: descriptor.get
          };
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    for (const name of Object.getOwnPropertyNames(Value.prototype)) {
      if (name === 'constructor' || Class.prototype.hasOwnProperty(name)) continue;
      Object.defineProperty(
        Class.prototype, name, Object.getOwnPropertyDescriptor(Value.prototype, name));
    }
    return computedProperties;
  }

  _mountClass(Class) {
    const computedProperties = this._augmentClass(Class);
    let mounts = Class.$trussMount;
    if (!mounts) throw new Error(`Class ${Class.name} lacks a $trussMount static property`);
    if (!_.isArray(mounts)) mounts = [mounts];
    return _.map(mounts, mount => {
      if (_.isString(mount)) mount = {path: mount};
      const matcher = makePathMatcher(mount.path);
      for (const variable of matcher.variables) {
        if (variable === '$' || variable.charAt(1) === '$') {
          throw new Error(`Invalid variable name: ${variable}`);
        }
        if (variable.charAt(0) === '$' && (
            _.has(Value.prototype, variable) || RESERVED_VALUE_PROPERTY_NAMES[variable]
        )) {
          throw new Error(`Variable name conflicts with built-in property or method: ${variable}`);
        }
      }
      const escapedKey = mount.path.match(/\/([^/]*)$/)[1];
      if (mount.placeholder && escapedKey.charAt(0) === '$') {
        throw new Error(
          `Class ${Class.name} mounted at wildcard ${escapedKey} cannot be a placeholder`);
      }
      return {Class, matcher, computedProperties, escapedKey, placeholder: mount.placeholder};
    });
  }

  /**
   * Creates a Truss object and sets all its basic properties: path segment variables, user-defined
   * properties, and computed properties.  The latter two will be enumerable so that Vue will pick
   * them up and make the reactive, so you should call _completeCreateObject once it's done so and
   * before any Firebase properties are added.
   */
  createObject(path, properties, truss) {
    let Class = Value;
    let computedProperties;
    for (const mount of this._mounts) {
      const match = mount.matcher.match(path);
      if (match) {
        Class = mount.Class;
        computedProperties = mount.computedProperties;
        for (const variable in match) {
          properties[variable] = {
            value: match[variable], writable: false, configurable: false, enumerable: false
          };
        }
        break;
      }
    }

    const object = new Class(truss);

    if (computedProperties) {
      _.each(computedProperties, prop => {
        properties[prop.name] = this._buildComputedPropertyDescriptor(object, prop);
      });
    }

    return object;
  }

  _buildComputedPropertyDescriptor(object, prop) {
    if (!computedPropertyStats[prop.fullName]) {
      Object.defineProperty(computedPropertyStats, prop.fullName, {
        value: new ComputedPropertyStats(prop.fullName), writable: false, enumerable: true,
        configurable: false
      });
    }
    const stats = computedPropertyStats[prop.fullName];

    let value;
    let writeAllowed = false;
    let firstCallback = true;

    if (!object.$$initializers) {
      Object.defineProperty(object, '$$initializers', {
        value: [], writable: false, enumerable: false, configurable: true});
    }
    object.$$initializers.push(vue => {
      object.$$finalizers.push(
        vue.$watch(computeValue.bind(object, prop, stats), newValue => {
          if (firstCallback) {
            stats.numUpdates += 1;
            value = newValue;
            firstCallback = false;
          } else {
            if (_.isEqual(value, newValue, isTrussValueEqual)) return;
            stats.numUpdates += 1;
            writeAllowed = true;
            object[prop.name] = newValue;
            writeAllowed = false;
          }
        }, {immediate: true})  // use immediate:true since watcher will run computeValue anyway
      );
    });
    return {
      enumerable: true, configurable: true,
      get: function() {
        if (value instanceof ErrorWrapper) throw value.error;
        return value;
      },
      set: function(newValue) {
        if (!writeAllowed) throw new Error(`You cannot set a computed property: ${prop.name}`);
        value = newValue;
      }
    };
  }

  isPlaceholder(path) {
    // TODO: optimize by precomputing a single all-placeholder-paths regex
    return _.some(this._mounts, mount => mount.placeholder && mount.matcher.test(path));
  }

  forEachPlaceholderChild(path, iteratee) {
    _.each(this._mounts, mount => {
      if (mount.placeholder && mount.matcher.testParent(path)) {
        iteratee(mount.escapedKey, mount.placeholder);
      }
    });
  }

  checkVueObject(object, path) {
    for (const key of Object.getOwnPropertyNames(object)) {
      if (RESERVED_VALUE_PROPERTY_NAMES[key]) continue;
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if ('value' in descriptor || !descriptor.get || !descriptor.set) {
        throw new Error(`Firetruss object at ${path} has a rogue property: ${key}`);
      }
      const value = object[key];
      if (_.isObject(value)) this.checkVueObject(value, joinPath(path, escapeKey(key)));
    }
  }

  static get computedPropertyStats() {
    return computedPropertyStats;
  }
}


function computeValue(prop, stats) {
  // jshint validthis: true
  // Touch this object, since a failed access to a missing property doesn't get captured as a
  // dependency.
  this.$$touchThis();

  const startTime = performanceNow();
  try {
    return prop.get.call(this);
  } catch (e) {
    return new ErrorWrapper(e);
  } finally {
    stats.runtime += performanceNow() - startTime;
    stats.numRecomputes += 1;
  }
  // jshint validthis: false
}

function isTrussValueEqual(a, b) {
  if (a && a.$truss || b && b.$truss) return a === b;
}

class Transaction {
  constructor(path, tree) {
    this._path = path;
    this._tree = tree;
  }

  get currentValue() {return this._tree.getObject(this._path);}
  get outcome() {return this._outcome;}
  get values() {return this._values;}

  _setOutcome(value) {
    if (this._outcome) throw new Error('Transaction already resolved with ' + this._outcome);
    this._outcome = value;
  }

  abort() {
    this._setOutcome('abort');
  }

  cancel() {
    this._setOutcome('cancel');
  }

  set(value) {
    if (value === undefined) throw new Error('Invalid argument: undefined');
    this._setOutcome('set');
    this._values = {'': value};
  }

  update(values) {
    if (values === undefined) throw new Error('Invalid argument: undefined');
    if (_.isEmpty(values)) return this.cancel();
    this._setOutcome('update');
    this._values = values;
  }
}


class Tree {
  constructor(truss, rootUrl, bridge, dispatcher) {
    this._truss = truss;
    this._rootUrl = rootUrl;
    this._bridge = bridge;
    this._dispatcher = dispatcher;
    this._firebasePropertyEditAllowed = false;
    this._writeSerial = 0;
    this._localWrites = {};
    this._localWriteTimestamp = null;
    this._coupler = new Coupler(
      rootUrl, bridge, dispatcher, this._integrateSnapshot.bind(this), this._prune.bind(this));
    this._vue = new Vue({data: {$root: undefined}});
    if (angularProxy.active) {
      this._vue.$watch('$data', angularProxy.digest, {deep: true});
    }
    // Call this.init(classes) to complete initialization; we need two phases so that truss can bind
    // the tree into its own accessors prior to defining computed functions, which may try to
    // access the tree root via truss.
  }

  get root() {
    return this._vue.$data.$root;
  }

  get truss() {
    return this._truss;
  }

  init(classes) {
    this._modeler = new Modeler(classes);
    this._vue.$data.$root = this._createObject('/', '');
    this._completeCreateObject(this.root);
    this._plantPlaceholders(this.root, '/');
  }

  destroy() {
    this._coupler.destroy();
    if (this._modeler) this._modeler.destroy();
    this._vue.$destroy();
  }

  connectReference(ref, valueCallback, method) {
    this._checkHandle(ref);
    const operation = this._dispatcher.createOperation('read', method, ref);
    let unwatch;
    if (valueCallback) {
      const segments = _(ref.path).split('/').map(segment => unescapeKey(segment)).value();
      unwatch = this._vue.$watch(
        this.getObject.bind(this, segments), valueCallback, {immediate: true});
    }
    operation._disconnect = this._disconnectReference.bind(this, ref, operation, unwatch);
    this._dispatcher.begin(operation).then(() => {
      if (operation.running && !operation._disconnected) {
        this._coupler.couple(ref.path, operation);
        operation._coupled = true;
      }
    }).catch(e => {});  // ignore exception, let onFailure handlers deal with it
    return operation._disconnect;
  }

  _disconnectReference(ref, operation, unwatch, error) {
    if (operation._disconnected) return;
    operation._disconnected = true;
    if (unwatch) unwatch();
    if (operation._coupled) {
      this._coupler.decouple(ref.path, operation);  // will call back to _prune if necessary
      operation._coupled = false;
    }
    this._dispatcher.end(operation, error).catch(e => {});
  }

  isReferenceReady(ref) {
    this._checkHandle(ref);
    return this._coupler.isSubtreeReady(ref.path);
  }

  connectQuery(query, keysCallback, method) {
    this._checkHandle(query);
    const operation = this._dispatcher.createOperation('read', method, query);
    operation._disconnect = this._disconnectQuery.bind(this, query, operation);
    this._dispatcher.begin(operation).then(() => {
      if (operation.running && !operation._disconnected) {
        this._coupler.subscribe(query, operation, keysCallback);
        operation._coupled = true;
      }
    }).catch(e => {});  // ignore exception, let onFailure handlers deal with it
    return operation._disconnect;
  }

  _disconnectQuery(query, operation, error) {
    if (operation._disconnected) return;
    operation._disconnected = true;
    if (operation._coupled) {
      this._coupler.unsubscribe(query, operation);  // will call back to _prune if necessary
      operation._coupled = false;
    }
    this._dispatcher.end(operation, error).catch(e => {});
  }

  isQueryReady(query) {
    return this._coupler.isQueryReady(query);
  }

  _checkHandle(handle) {
    if (!handle.belongsTo(this._truss)) {
      throw new Error('Reference belongs to another Truss instance');
    }
  }

  update(ref, method, values) {
    const numValues = _.size(values);
    if (!numValues) return;
    if (method === 'update' || method === 'override') {
      checkUpdateHasOnlyDescendantsWithNoOverlap(ref.path, values);
    }
    this._applyLocalWrite(values, method === 'override');
    if (method === 'override') return Promise.resolve();
    const url = this._rootUrl + this._extractCommonPathPrefix(values);
    return this._dispatcher.execute('write', method, ref, () => {
      if (numValues === 1) {
        return this._bridge.set(url, values[''], this._writeSerial);
      } else {
        return this._bridge.update(url, values, this._writeSerial);
      }
    });
  }

  commit(ref, updateFunction) {
    let tries = 0;

    const attemptTransaction = () => {
      if (tries++ >= 25) return Promise.reject(new Error('maxretry'));
      const txn = new Transaction();
      try {
        updateFunction(txn);
      } catch (e) {
        return Promise.reject(e);
      }
      const oldValue = toFirebaseJson(this.getObject(ref.path));
      switch (txn.outcome) {
        case 'abort': return;
        case 'cancel':
          break;
        case 'set':
          this._applyLocalWrite({[ref.path]: txn.values['']});
          break;
        case 'update':
          checkUpdateHasOnlyDescendantsWithNoOverlap(ref.path, txn.values, true);
          this._applyLocalWrite(txn.values);
          break;
        default:
          throw new Error('Invalid transaction outcome: ' + (txn.outcome || 'none'));
      }
      return this._bridge.transaction(
        this._rootUrl + ref.path, oldValue, txn.values
      ).then(committed => {
        if (!committed) return attemptTransaction();
        return txn;
      });
    };

    return this._truss.peek(ref, () => {
      return this._dispatcher.execute('write', 'commit', ref, attemptTransaction);
    });
  }

  _applyLocalWrite(values, override) {
    // TODO: correctly apply local writes that impact queries.  Currently, a local write will update
    // any objects currently selected by a query, but won't add or remove results.
    this._writeSerial++;
    this._localWriteTimestamp = this._truss.now;
    _.each(values, (value, path) => {
      const coupledDescendantPaths = this._coupler.findCoupledDescendantPaths(path);
      if (_.isEmpty(coupledDescendantPaths)) return;
      const offset = (path === '/' ? 0 : path.length) + 1;
      for (const descendantPath of coupledDescendantPaths) {
        const subPath = descendantPath.slice(offset);
        let subValue = value;
        if (subPath) {
          const segments = subPath.split('/');
          for (const segment of segments) {
            subValue = subValue[unescapeKey(segment)];
            if (subValue === undefined) break;
          }
        }
        if (subValue === undefined || subValue === null) {
          this._prune(subPath);
        } else {
          const key = unescapeKey(_.last(descendantPath.split('/')));
          this._plantValue(
            descendantPath, key, subValue, this._scaffoldAncestors(descendantPath), false,
            override
          );
        }
        if (!override) this._localWrites[descendantPath] = this._writeSerial;
      }
    });
  }

  _extractCommonPathPrefix(values) {
    let prefixSegments;
    _.each(values, (value, path) => {
      const segments = path === '/' ? [''] : path.split('/');
      if (prefixSegments) {
        let firstMismatchIndex = 0;
        const maxIndex = Math.min(prefixSegments.length, segments.length);
        while (firstMismatchIndex < maxIndex &&
               prefixSegments[firstMismatchIndex] === segments[firstMismatchIndex]) {
          firstMismatchIndex++;
        }
        prefixSegments = prefixSegments.slice(0, firstMismatchIndex);
        if (!prefixSegments.length) return false;
      } else {
        prefixSegments = segments;
      }
    });
    const pathPrefix = prefixSegments.length === 1 ? '/' : prefixSegments.join('/');
    _.each(_.keys(values), key => {
      values[key.slice(pathPrefix.length + 1)] = values[key];
      delete values[key];
    });
    return pathPrefix;
  }

  /**
   * Creates a Truss object and sets all its basic properties: path segment variables, user-defined
   * properties, and computed properties.  The latter two will be enumerable so that Vue will pick
   * them up and make the reactive, so you should call _completeCreateObject once it's done so and
   * before any Firebase properties are added.
   */
  _createObject(path, key, parent) {
    let properties = {
      // We want Vue to wrap this; we'll make it non-enumerable in _completeCreateObject.
      $parent: {value: parent, configurable: true, enumerable: true},
      $path: {value: path},
      // $$touchThis: {
      //   value: parent ? () => parent[key] : () => this._vue.$data.$root,
      //   writable: false, configurable: false, enumerable: false
      // }
    };
    if (path === '/') properties.$truss = {value: this._truss};

    const object = this._modeler.createObject(path, properties, this._truss);
    Object.defineProperties(object, properties);
    return object;
  }

  // To be called on the result of _createObject after it's been inserted into the _vue hierarchy
  // and Vue has had a chance to initialize it.
  _completeCreateObject(object) {
    for (const name of Object.getOwnPropertyNames(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (descriptor.configurable && descriptor.enumerable) {
        descriptor.enumerable = false;
        if (name === '$parent') descriptor.configurable = false;
        Object.defineProperty(object, name, descriptor);
      }
    }
    if (object.$$initializers) {
      for (const fn of object.$$initializers) fn(this._vue);
      delete object.$$initializers;
    }
  }

  _destroyObject(object) {
    if (!(object && object.$truss)) return;
    if (object.$$finalizers) {
      // Some destructors remove themselves from the array, so clone it before iterating.
      for (const fn of _.clone(object.$$finalizers)) fn();
    }
    for (const key in object) {
      if (!Object.hasOwnProperty(object, key)) continue;
      this._destroyObject(object[key]);
    }
  }

  _integrateSnapshot(snap) {
    _.each(_.keys(this._localWrites), (writeSerial, path) => {
      if (snap.writeSerial >= writeSerial) delete this._localWrites[path];
    });
    if (snap.exists) {
      const parent = this._scaffoldAncestors(snap.path, true);
      if (parent) this._plantValue(snap.path, snap.key, snap.value, parent, true, false);
    } else {
      this._prune(snap.path, null, true);
    }
  }

  _scaffoldAncestors(path, remoteWrite) {
    let object;
    const segments = _(path).split('/').dropRight().value();
    _.each(segments, (segment, i) => {
      const childKey = unescapeKey(segment);
      let child = childKey ? object[childKey] : this.root;
      if (!child) {
        const ancestorPath = segments.slice(0, i + 1).join('/');
        if (remoteWrite && this._localWrites[ancestorPath || '/']) return;
        child = this._plantValue(ancestorPath, childKey, {}, object);
      }
      object = child;
    });
    return object;
  }

  _plantValue(path, key, value, parent, remoteWrite, override) {
    if (value === null || value === undefined) {
      throw new Error('Snapshot includes invalid value: ' + value);
    }
    if (remoteWrite && this._localWrites[path]) return;
    if (value === SERVER_TIMESTAMP) value = this._localWriteTimestamp;
    if (!_.isArray(value) && !_.isObject(value)) {
      this._setFirebaseProperty(parent, key, value);
      return;
    }
    let object = parent[key];
    if (!_.isObject(object)) {
      object = this._createObject(path, key, parent);
      this._setFirebaseProperty(parent, key, object);
      this._completeCreateObject(object);
    }
    if (override) {
      Object.defineProperty(object, '$overridden', {get: _.constant(true), configurable: true});
    } else if (object.$overridden) {
      delete object.$overridden;
    }
    _.each(value, (item, escapedChildKey) => {
      this._plantValue(
        joinPath(path, escapedChildKey), unescapeKey(escapedChildKey), item, object, remoteWrite,
        override
      );
    });
    _.each(object, (item, childKey) => {
      const escapedChildKey = escapeKey(childKey);
      if (!value.hasOwnProperty(escapedChildKey)) {
        this._prune(joinPath(path, escapedChildKey), null, remoteWrite);
      }
    });
    this._plantPlaceholders(object, path);
    return object;
  }

  _plantPlaceholders(object, path) {
    this._modeler.forEachPlaceholderChild(path, (escapedKey, placeholder) => {
      const key = unescapeKey(escapedKey);
      if (!object.hasOwnProperty(key)) {
        this._plantValue(joinPath(path, escapedKey), key, placeholder, object);
      }
    });
  }

  _prune(path, lockedDescendantPaths, remoteWrite) {
    lockedDescendantPaths = lockedDescendantPaths || {};
    const object = this.getObject(path);
    if (object === undefined) return;
    if (remoteWrite && this._avoidLocalWritePaths(path, lockedDescendantPaths)) return;
    if (!(_.isEmpty(lockedDescendantPaths) && this._pruneAncestors(path, object)) &&
        _.isObject(object)) {
      // The target object is a placeholder, and all ancestors are placeholders or otherwise needed
      // as well, so we can't delete it.  Instead, dive into its descendants to delete what we can.
      this._pruneDescendants(object, lockedDescendantPaths);
    }
  }

  _avoidLocalWritePaths(path, lockedDescendantPaths) {
    for (const localWritePath in this._localWrites) {
      if (!this._localWrites.hasOwnProperty(localWritePath)) continue;
      if (path === localWritePath || localWritePath === '/' ||
          _.startsWith(path, localWritePath + '/')) return true;
      if (path === '/' || _.startsWith(localWritePath, path + '/')) {
        const segments = localWritePath.split('/');
        for (let i = segments.length; i > 0; i--) {
          const subPath = segments.slice(0, i).join('/');
          const active = i === segments.length;
          if (lockedDescendantPaths[subPath] || lockedDescendantPaths[subPath] === active) break;
          lockedDescendantPaths[subPath] = active;
          if (subPath === path) break;
        }
      }
    }
  }

  _pruneAncestors(targetPath, targetObject) {
    // Destroy the child (unless it's a placeholder that's still needed) and any ancestors that
    // are no longer needed to keep this child rooted, and have no other reason to exist.
    let deleted = false;
    let object = targetObject;
    // The target object may be a primitive, in which case it won't have $parent and $key
    // properties.  In that case, use the target path to figure those out instead.  Note that all
    // ancestors of the target object will necessarily not be primitives and will have those
    // properties.
    const targetSegments = _(targetPath).split('/').map(unescapeKey).value();
    while (object && object !== this.root) {
      const parent =
        object.$parent || object === targetObject && this.getObject(targetSegments.slice(0, -1));
      if (!this._modeler.isPlaceholder(object.$path)) {
        const ghostObjects = deleted ? null : [targetObject];
        if (!this._holdsConcreteData(object, ghostObjects)) {
          deleted = true;
          this._deleteFirebaseProperty(
            parent, object.$key || object === targetObject && _.last(targetSegments));
        }
      }
      object = parent;
    }
    return deleted;
  }

  _holdsConcreteData(object, ghostObjects) {
    if (ghostObjects && _.includes(ghostObjects, object)) return false;
    if (_.some(object, value => !value.$truss)) return true;
    return _.some(object, value => this._holdsConcreteData(value, ghostObjects));
  }

  _pruneDescendants(object, lockedDescendantPaths) {
    if (lockedDescendantPaths[object.$path]) return true;
    if (object.$overridden) delete object.$overridden;
    let coupledDescendantFound = false;
    _.each(object, (value, key) => {
      let shouldDelete = true;
      let valueLocked;
      if (lockedDescendantPaths[joinPath(object.$path, escapeKey(key))]) {
        shouldDelete = false;
        valueLocked = true;
      } else if (value.$truss) {
        const placeholder = this._modeler.isPlaceholder(value.$path);
        if (placeholder || _.has(lockedDescendantPaths, value.$path)) {
          valueLocked = this._pruneDescendants(value, lockedDescendantPaths);
          shouldDelete = !placeholder && !valueLocked;
        }
      }
      if (shouldDelete) this._deleteFirebaseProperty(object, key);
      coupledDescendantFound = coupledDescendantFound || valueLocked;
    });
    return coupledDescendantFound;
  }

  getObject(pathOrSegments) {
    let object;
    const segments = _.isString(pathOrSegments) ?
      _(pathOrSegments).split('/').map(unescapeKey).value() : pathOrSegments;
    for (const segment of segments) {
      object = segment ? object[segment] : this.root;
      if (object === undefined) return;
    }
    return object;
  }

  _getFirebasePropertyDescriptor(object, key) {
    let descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor) {
      if (!descriptor.enumerable) {
        throw new Error(
          `Key conflict between Firebase and instance or computed properties at ` +
          `${object.$path}: ${key}`);
      }
      if (!descriptor.get || !descriptor.set) {
        throw new Error(`Unbound property at ${object.$path}: ${key}`);
      }
    }
    return descriptor;
  }

  _setFirebaseProperty(object, key, value) {
    let descriptor = this._getFirebasePropertyDescriptor(object, key);
    if (descriptor) {
      this._firebasePropertyEditAllowed = true;
      object[key] = value;
      this._firebasePropertyEditAllowed = false;
    } else {
      Vue.set(object, key, value);
      descriptor = Object.getOwnPropertyDescriptor(object, key);
      Object.defineProperty(object, key, {
        get: descriptor.get, set: this._overwriteFirebaseProperty.bind(this, descriptor, key),
        configurable: true, enumerable: true
      });
    }
  }

  _overwriteFirebaseProperty(descriptor, key, newValue) {
    if (!this._firebasePropertyEditAllowed) {
      throw new Error(`Firebase data cannot be mutated directly: ${key}`);
    }
    descriptor.set.call(this, newValue);
  }

  _deleteFirebaseProperty(object, key) {
    // Make sure it's actually a Firebase property.
    this._getFirebasePropertyDescriptor(object, key);
    this._destroyObject(object[key]);
    Vue.delete(object, key);
  }

  checkVueObject(object, path) {
    this._modeler.checkVueObject(object, path);
  }

  static get computedPropertyStats() {
    return Modeler.computedPropertyStats;
  }
}


function checkUpdateHasOnlyDescendantsWithNoOverlap(rootPath, values, relativizePaths) {
  // First, check all paths for correctness and absolutize them, since there could be a mix of
  // absolute paths and relative keys.
  _.each(_.keys(values), path => {
    if (path.charAt(0) === '/') {
      if (!(path === rootPath || rootPath === '/' ||
            _.startsWith(path, rootPath + '/') && path.length > rootPath.length + 1)) {
        throw new Error(`Update item is not a descendant of target ref: ${path}`);
      }
    } else {
      if (path.indexOf('/') >= 0) {
        throw new Error(`Update item deep path must be absolute, taken from a reference: ${path}`);
      }
      const absolutePath = joinPath(rootPath, escapeKey(path));
      if (values.hasOwnProperty(absolutePath)) {
        throw new Error(`Update items overlap: ${path} and ${absolutePath}`);
      }
      values[absolutePath] = values[path];
      delete values[path];
    }
  });
  // Then check for overlaps and relativize if desired.
  const allPaths = _(values).keys().map(path => joinPath(path, '')).sortBy('length').value();
  _.each(_.keys(values), path => {
    for (const otherPath of allPaths) {
      if (otherPath.length > path.length) break;
      if (path !== otherPath && _.startsWith(path, otherPath)) {
        throw new Error(`Update items overlap: ${otherPath} and ${path}`);
      }
    }
    if (relativizePaths) {
      values[path.slice(rootPath === '/' ? 1 : rootPath.length + 1)] = values[path];
      delete values[path];
    }
  });
}

function toFirebaseJson(object) {
  if (typeof object === 'object') {
    const result = {};
    for (const key in object) {
      if (!object.hasOwnProperty(key)) continue;
      result[escapeKey(key)] = toFirebaseJson(object[key]);
    }
    return result;
  } else {
    return object;
  }
}

let bridge;
let logging;
const workerFunctions = {};
// This version is filled in by the build, don't reformat the line.
const VERSION = 'dev';


class Truss {

  /**
   * Create a new Truss instance, specific to a given datastore.  To avoid confusion there should be
   * exactly one Truss per root datastore URL, so in most code this will be a singleton.
   *
   * @param rootUrl {String} The root URL, https://{project}.firebaseio.com.
   * @param classes {Array<Function>} A list of the classes to map onto the datastore structure.
   *    Each class must have a static $trussMount property that is a (wildcarded) datastore path, or
   *    an options object {path: string, placeholder: object}, or an array of either.
   */
  constructor(rootUrl, classes) {
    // TODO: allow rootUrl to be a test database object for testing
    if (!bridge) {
      throw new Error('Truss worker not connected, please call Truss.connectWorker first');
    }
    this._rootUrl = rootUrl.replace(/\/$/, '');
    this._keyGenerator = new KeyGenerator();
    this._dispatcher = new Dispatcher(bridge);
    this._vue = new Vue();

    bridge.trackServer(this._rootUrl);
    this._metaTree = new MetaTree(this._rootUrl, bridge);
    this._tree = new Tree(this, this._rootUrl, bridge, this._dispatcher);
    this._tree.init(classes);
  }

  get meta() {return this._metaTree.root;}
  get root() {return this._tree.root;}

  destroy() {
    this._vue.$destroy();
    this._tree.destroy();
    this._metaTree.destroy();
  }

  get now() {return Date.now() + this.meta.timeOffset;}
  newKey() {return this._keyGenerator.generateUniqueKey(this.now);}

  authenticate(token) {
    return this._dispatcher.execute('auth', 'authenticate', new Reference(this._tree, '/'), () => {
      return bridge.authWithCustomToken(this._rootUrl, token, {rememberMe: true});
    });
  }

  unauthenticate() {
    return this._dispatcher.execute(
      'auth', 'unauthenticate', new Reference(this._tree, '/'), () => {
        return bridge.unauth(this._rootUrl);
      }
    );
  }

  intercept(actionType, callbacks) {
    return this._dispatcher.intercept(actionType, callbacks);
  }

  // connections are {key: Query | Object | fn() -> (Query | Object)}
  connect(scope, connections) {
    if (!connections) {
      connections = scope;
      scope = undefined;
      if (connections instanceof Handle) connections = {_: connections};
    }
    return new Connector(scope, connections, this._tree, 'connect');
  }

  // target is Reference, Query, or connection Object like above
  peek(target, callback) {
    callback = wrapPromiseCallback(callback);
    return new Promise((resolve, reject) => {
      const scope = {};
      const connector = new Connector(scope, {result: target}, this._tree, 'peek');
      const unwatch = this._vue.$watch(() => connector.ready, ready => {
        if (!ready) return;
        unwatch();
        callback(scope.result).then(result => {
          connector.destroy();
          resolve(result);
        }, error => {
          connector.destroy();
          reject(error);
        });
      });
    });
  }

  watch(subjectFn, callbackFn, options) {
    let numCallbacks = 0;

    const unwatch = this._vue.$watch(subjectFn, (newValue, oldValue) => {
      numCallbacks++;
      if (numCallbacks === 1) {
        // Delay the immediate callback until we've had a chance to return the unwatch function.
        Promise.resolve().then(() => {
          if (numCallbacks > 1) return;
          if (subjectFn() !== newValue) return;
          callbackFn(newValue, oldValue);
          angularProxy.digest();
        });
      } else {
        callbackFn(newValue, oldValue);
        angularProxy.digest();
      }
    }, {immediate: true, deep: options && options.deep});

    return unwatch;
  }

  when(expression, options) {
    let unwatch;
    const promise = new Promise(resolve => {
      unwatch = this.watch(expression, value => {
        if (value !== undefined && value !== null) {
          promise.cancel();
          resolve(value);
        }
      }, options);
    });
    promise.cancel = unwatch;
    return promise;
  }

  checkObjectsForRogueProperties() {
    this._tree.checkVueObject(this._tree.root, '/');
  }

  static get computedPropertyStats() {return this._tree.computedPropertyStats;}

  static connectWorker(webWorker) {
    if (bridge) throw new Error('Worker already connected');
    if (_.isString(webWorker)) {
      const Worker = window.SharedWorker || window.Worker;
      if (!Worker) throw new Error('Browser does not implement Web Workers');
      webWorker = new Worker(webWorker);
    }
    bridge = new Bridge(webWorker);
    if (logging) bridge.enableLogging(logging);
    return bridge.init(webWorker).then(
      ({exposedFunctionNames, firebaseSdkVersion}) => {
        Object.defineProperty(Truss, 'FIREBASE_SDK_VERSION', {value: firebaseSdkVersion});
        for (const name of exposedFunctionNames) {
          Truss.worker[name] = bridge.bindExposedFunction(name);
        }
      }
    );
  }

  static get worker() {return workerFunctions;}
  static preExpose(functionName) {
    Truss.worker[functionName] = bridge.bindExposedFunction(functionName);
  }

  static bounceConnection() {return bridge.bounceConnection();}
  static suspend() {return bridge.suspend();}
  static debugPermissionDeniedErrors(simulatedTokenGenerator, maxSimulationDuration, callFilter) {
    return bridge.debugPermissionDeniedErrors(
      simulatedTokenGenerator, maxSimulationDuration, callFilter);
  }

  static debounceAngularDigest(wait) {
    angularProxy.debounceDigest(wait);
  }

  static escapeKey(key) {return escapeKey(key);}
  static unescapeKey(escapedKey) {return unescapeKey(escapedKey);}

  static enableLogging(fn) {
    logging = fn;
    if (bridge) bridge.enableLogging(fn);
  }

  // Duplicate static constants on instance for convenience.
  get SERVER_TIMESTAMP() {return Truss.SERVER_TIMESTAMP;}
  get VERSION() {return Truss.VERSION;}
  get FIREBASE_SDK_VERSION() {return Truss.FIREBASE_SDK_VERSION;}
}

Object.defineProperties(Truss, {
  SERVER_TIMESTAMP: {value: SERVER_TIMESTAMP},
  VERSION: {value: VERSION}
});

angularProxy.defineModule(Truss);

export default Truss;

//# sourceMappingURL=firetruss.es2015.js.map