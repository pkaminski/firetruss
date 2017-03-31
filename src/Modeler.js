import Reference from './Reference.js';
import Connector from './Connector.js';
import {makePathMatcher, joinPath, escapeKey, unescapeKey, promiseFinally} from './utils.js';

import _ from 'lodash';
import performanceNow from 'performance-now';

// These are defined separately for each object so they're not included in Value below.
const RESERVED_VALUE_PROPERTY_NAMES = {
  $truss: true, $parent: true, $key: true, $path: true, $ref: true,
  $$touchThis: true, $$initializers: true, $$finalizers: true,
  $$$trussCheck: true,
  __ob__: true
};

const computedPropertyStats = {};

// Holds properties that we're going to set on a model object that's being created right now as soon
// as it's been created, but that we'd like to be accessible in the constructor.  The object
// prototype's getters will pick those up until they get overridden in the instance.
let creatingObjectProperties;


class Value {
  get $parent() {return creatingObjectProperties.$parent.value;}
  get $path() {return creatingObjectProperties.$path.value;}
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
  get $meta() {return this.$truss.meta;}
  get $root() {return this.$truss.root;}  // access indirectly to leave dependency trace
  get $now() {return this.$truss.now;}
  get $ready() {return this.$ref.ready;}
  get $overridden() {return false;}

  $intercept(actionType, callbacks) {
    const unintercept = this.$truss.intercept(actionType, callbacks);
    const uninterceptAndRemoveFinalizer = () => {
      unintercept();
      _.pull(this.$$finalizers, uninterceptAndRemoveFinalizer);
    };
    this.$$finalizers.push(uninterceptAndRemoveFinalizer);
    return uninterceptAndRemoveFinalizer;
  }

  $peek(target, callback) {
    const promise = promiseFinally(
      this.$truss.peek(target, callback), () => {_.pull(this.$$finalizers, promise.cancel);}
    );
    this.$$finalizers.push(promise.cancel);
    return promise;
  }

  $watch(subjectFn, callbackFn, options) {
    let unwatchAndRemoveFinalizer;

    const unwatch = this.$truss.watch(() => {
      this.$$touchThis();
      return subjectFn.call(this);
    }, callbackFn.bind(this), options);

    unwatchAndRemoveFinalizer = () => {
      unwatch();
      _.pull(this.$$finalizers, unwatchAndRemoveFinalizer);
    };
    this.$$finalizers.push(unwatchAndRemoveFinalizer);
    return unwatchAndRemoveFinalizer;
  }

  $when(expression, options) {
    const promise = promiseFinally(this.$truss.when(() => {
      this.$$touchThis();
      return expression.call(this);
    }, options), () => {_.pull(this.$$finalizers, promise.cancel);});
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


export default class Modeler {
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
    Object.freeze(this);
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
  createObject(path, properties) {
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

    creatingObjectProperties = properties;
    const object = new Class();
    creatingObjectProperties = null;

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

    if (!object.$$initializers) {
      Object.defineProperty(object, '$$initializers', {
        value: [], writable: false, enumerable: false, configurable: true});
    }
    object.$$initializers.push(vue => {
      object.$$finalizers.push(
        vue.$watch(computeValue.bind(object, prop, stats), newValue => {
          if (_.isEqual(value, newValue, isTrussValueEqual)) return;
          stats.numUpdates += 1;
          writeAllowed = true;
          object[prop.name] = newValue;
          writeAllowed = false;
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

  destroyObject(object) {
    if (_.has(object, '$$finalizers')) {
      // Some destructors remove themselves from the array, so clone it before iterating.
      for (const fn of _.clone(object.$$finalizers)) fn();
    }
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

  checkVueObject(object, path, checkedObjects) {
    const top = !checkedObjects;
    checkedObjects = checkedObjects || [];
    for (const key of Object.getOwnPropertyNames(object)) {
      if (RESERVED_VALUE_PROPERTY_NAMES[key]) continue;
      // jshint loopfunc:true
      const mount = _.find(this._mounts, mount => mount.Class === object.constructor);
      // jshint loopfunc:false
      if (mount && _.includes(mount.matcher.variables, key)) continue;
      if (!(Array.isArray(object) && (/\d+/.test(key) || key === 'length'))) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if ('value' in descriptor || !descriptor.get) {
          throw new Error(
            `Value at ${path}, contained in a Firetruss object, has a rogue property: ${key}`);
        }
        if (object.$truss && descriptor.enumerable) {
          try {
            object[key] = object[key];
            throw new Error(
              `Firetruss object at ${path} has an enumerable non-Firebase property: ${key}`);
          } catch (e) {
            if (e.trussCode !== 'firebase_overwrite') throw e;
          }
        }
      }
      const value = object[key];
      if (_.isObject(value) && !value.$$$trussCheck && Object.isExtensible(value) &&
          !(value instanceof Function)) {
        value.$$$trussCheck = true;
        checkedObjects.push(value);
        this.checkVueObject(value, joinPath(path, escapeKey(key)), checkedObjects);
      }
    }
    if (top) {
      for (const item of checkedObjects) delete item.$$$trussCheck;
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
