(function() {
    function randInt(bits) {
        if (bits < 1 || bits > 53) {
            throw new TypeError();
        } else {
            if (bits >= 1 && bits <= 30) {
                return 0 | ((1 << bits) * Math.random());
            } else {
                var high = (0 | ((1 << (bits - 30)) * Math.random())) * (1 << 30);
                var low = 0 | ((1 << 30) * Math.random());
                return  high + low;
            }
        }
    }


    function toHex(x, length) {
        var rv = x.toString(16);
        while (rv.length < length) {
            rv = "0" + rv;
        }
        return rv;
    }

    function createUuid() {
        return [toHex(randInt(32), 8),
         toHex(randInt(16), 4),
         toHex(0x4000 | randInt(12), 4),
         toHex(0x8000 | randInt(14), 4),
         toHex(randInt(48), 12)].join("-");
    }


    // TODO: should be a way to clean up unused sockets
    class SocketCache {
        constructor() {
            this.readSockets = new Map();
            this.writeSockets = new Map();
        };

        async getOrCreate(type, uuid, onmessage=null) {
            function createSocket() {
                let protocol = self.isSecureContext ? "wss" : "ws";
                let port = self.isSecureContext? "{{ports[wss][0]}}" : "{{ports[ws][0]}}";
                let url = `${protocol}://{{host}}:${port}/msg_channel?uuid=${uuid}&direction=${type}`;
                let socket = new WebSocket(url);
                if (onmessage !== null) {
                    socket.onmessage = onmessage;
                };
                return new Promise(resolve => socket.addEventListener("open", () => resolve(socket)));
            }

            let socket;
            if (type === "read") {
                if (this.readSockets.has(uuid)) {
                    throw new Error("Can't create multiple read sockets with same UUID");
                }
                socket = await createSocket();
                socket.addEventListener("close", () => this.readSockets.delete(uuid));
                this.readSockets.set(uuid, socket);
            } else if (type === "write") {
                let count;
                if (onmessage !== null) {
                    throw new Error("Can't set message handler for write sockets");
                }
                if (this.writeSockets.has(uuid)) {
                    [socket, count] = this.writeSockets.get(uuid);
                } else {
                    socket = await createSocket();
                    count = 0;
                }
                count += 1;
                socket.addEventListener("close", () => this.writeSockets.delete(uuid));
                this.writeSockets.set(uuid, [socket, count]);
            } else {
                throw new Error(`Unknown type ${type}`);
            }
            return socket;
        };

        async close(type, uuid) {
            let target = type === "read" ? this.readSockets : this.writeSockets;
            const data = target.get(uuid);
            if (!data) {
                return;
            }
            let count, socket;
            if (type == "read") {
                socket = data;
                count = 0;
            } else if (type === "write") {
                [socket, count] = data;
                count -= 1;
                if (count > 0) {
                    target.set(uuid, [socket, count]);
                }
            };
            if (count <= 0 && socket) {
                target.delete(uuid);
                socket.close(1000);
                await new Promise(resolve => socket.onclose = () => resolve());
            }
        };

        async closeAll() {
            let sockets = [];
            this.readSockets.forEach(value => sockets.push(value));
            this.writeSockets.forEach(value => sockets.push(value[0]));
            let closePromises = sockets.map(socket => new Promise(resolve => socket.onclose = () => resolve()));
            sockets.forEach(socket => socket.close(1000));
            this.readSockets.clear();
            this.writeSockets.clear();
            await Promise.all(closePromises);
        }
    }

    const socketCache = new SocketCache();

    class Channel {
        type = null;

        constructor(uuid) {
            /** UUID for the channel */
            this.uuid = uuid;
            this.socket = null;
            this.eventListeners = new Map([[
                "connect", new Set(),
                "close", new Set()]]);
        }

        hasConnection() {
            return this.socket !== null && this.socket.readyState <= WebSocket.OPEN;
        }

        /**
         * Connect to the channel.
         *
         * @param {Function} onmessage - Event handler function for
         * the underlying websocket message.
         */
        async connect(onmessage) {
            if (this.hasConnection()) {
                return;
            }
            this.socket = await socketCache.getOrCreate(this.type, this.uuid, onmessage);
            this._dispatch("connect");
        }

        /**
         * Close the channel and underlying websocket connection
         */
        async close() {
            this.socket = null;
            await socketCache.close(this.type, this.uuid);
            this._dispatch("close");
        }

        /**
         * Add a event callback function. Supported message types are
         * "connect", "close", and "message" (for ``RecvChannel``).
         *
         * @param {string} type - Message type.
         * @param {Function} fn - Callback function. This is called
         * with an event-like object, with ``type`` and ``data``
         * properties.
         */
        addEventListener(type, fn) {
            if (typeof type !== "string") {
                throw new TypeError(`Expected string, got ${typeof type}`);
            }
            if (typeof fn !== "function") {
                throw new TypeError(`Expected function, got ${typeof fn}`);
            }
            if (!this.eventListeners.has(type)) {
                this.eventListeners.set(type, new Set());
            }
            this.eventListeners.get(type).add(fn);
        };

        /**
         * Remove an event callback function.
         *
         * @param {string} type - Message type.
         * @param {Function} fn - Callback function. This is called
         * with an event-like object, with ``type`` and ``data``
         * properties.
         */
        removeEventListener(type, fn) {
            if (!typeof type === "string") {
                throw new TypeError(`Expected string, got ${typeof type}`);
            }
            if (typeof fn !== "function") {
                throw new TypeError(`Expected function, got ${typeof fn}`);
            }
            let listeners = this.eventListeners.get(type);
            if (listeners) {
                listeners.delete(fn);
            }
        };

        _dispatch(type, data) {
            let listeners = this.eventListeners.get(type);
            if (listeners) {
                listeners.forEach(fn => fn({type, data}));
            }
        };

    }

    /**
     * Channel used to send messages
     */
    class SendChannel extends Channel {
        type = "write";

        /**
         * Connect to the channel. Automatically called when sending the
         * first message.
         */
        async connect() {
            return super.connect(null);
        }

        async _send(cmd, body=null) {
            if (!this.hasConnection()) {
                await this.connect();
            }
            this.socket.send(JSON.stringify([cmd, body]));
        }

        /**
         * Send a message. The message object must be JSON-serializable.
         *
         * @param {Object} msg - The message object to send.
         */
        async send(msg) {
            this._send("message", msg);
        }

        /**
         * Disconnect the associated `RecvChannel <#RecvChannel>`_, if
         * any, on the server side.
         */
        async disconnectReader() {
            this._send("disconnectReader");
        }

        /**
         * Disconnect this channel on the server side.
         */
        async delete() {
            this._send("delete");
        }
    };
    self.SendChannel = SendChannel;

    const recvChannelsCreated = new Set();

    class RecvChannel extends Channel {
        type = "read";

        constructor(uuid) {
            if (recvChannelsCreated.has(uuid)) {
                throw new Error(`Already created RecvChannel with id ${uuid}`);
            }
            super(uuid);
            this.eventListeners.set("message", new Set());
        }

        async connect() {
            if (this.hasConnection()) {
                return;
            }
            await super.connect(event => this.readMessage(event.data));
        }

        readMessage(data) {
            let msg = JSON.parse(data);
            this._dispatch("message", msg);
        }

        /**
         * Wait for the next message and return it (after passing it to
         * existing handlers)
         *
         * @returns {Promise} - Promise that resolves to the message data.
         */
        nextMessage() {
            return new Promise(resolve => {
                let fn = ({data}) => {
                    this.removeEventListener("message", fn);
                    resolve(data);
                };
                this.addEventListener("message", fn);
            });
        }
    }

    /**
     * Create a new channel pair
     *
     * @returns {[RecvChannel, SendChannel]}
     */
    self.channel = function() {
        let uuid = createUuid();
        let recvChannel = new RecvChannel(uuid);
        let sendChannel = new SendChannel(uuid);
        return [recvChannel, sendChannel];
    };

    /**
     * Create an unconnected channel defined by a `uuid` in
     * ``location.href`` for listening for `RemoteGlobal
     * <#RemoteGlobal>`_ messages.
     *
     * @returns {RemoteGlobalCommandRecvChannel} - Disconnected channel
     */
    self.global_channel = function() {
        let uuid = new URLSearchParams(location.search).get("uuid");
        if (!uuid) {
            throw new Error("URL must have a uuid parameter to use as a RemoteGlobal");
        }
        return new RemoteGlobalCommandRecvChannel(new RecvChannel(uuid));
    };

    /**
     * Start listening for `RemoteGlobal <#RemoteGlobal>`_ messages on
     * a channel defined by a `uuid` in `location.href`
     *
     * @returns {RemoteGlobalCommandRecvChannel} - Connected channel
     */
    self.start_global_channel = async function() {
        let channel = self.global_channel();
        await channel.connect();
        return channel;
    };

    self.closeAllChannelSockets = async function() {
        await socketCache.closeAll();
        await new Promise(resolve => setTimeout(resolve, 0));
    };

    /**
     * Handler for `RemoteGlobal <#RemoteGlobal>`_ commands.

     * This can't be constructed directly but must be obtained from
     * `global_channel() <#global_channel>`_ or
     * `<start_global_channel() <#start_global_channel>`_.
     */
    class RemoteGlobalCommandRecvChannel {
        constructor(recvChannel) {
            this.channel = recvChannel;
            this.uuid = recvChannel.uuid;
            this.channel.addEventListener("message", ({data}) => this.handleMessage(data));
            this.messageHandlers = new Set();
        };

        /**
         * Connect to the channel and start handling messages.
         */
        async connect() {
            await this.channel.connect();
        }

        /**
         * Close the channel and underlying websocket connection
         */
        async close() {
            await this.channel.close();
        }

        async handleMessage(msg) {
            const {id, command, params, respChannel} = msg;
            let result = {};
            let resp = {id, result};
            if (command === "call") {
                const fn = deserialize(params.fn);
                const args = params.args.map(x => {
                    return deserialize(x);
                });
                try {
                    let resultValue = await new Promise(resolve => {
                        Promise.resolve(fn(...args)).then(resolve);
                    });
                    result.result = serialize(resultValue);
                } catch(e) {
                    let exception = serialize(e);
                    const getAsInt = (obj, prop) =>  {
                        let value = parseInt(prop in obj ? obj[prop] : 0);
                        return Number.isNaN(value) ? 0 : value;
                    };
                    result.exceptionDetails = {
                        text: "" + e.toString(),
                        lineNumber: getAsInt(e, "lineNumber"),
                        columnNumber: getAsInt(e, "columnNumber"),
                        exception
                    };
                }
            } else if (command === "postMessage") {
                this.messageHandlers.forEach(fn => fn(deserialize(params.msg)));
            }
            if (respChannel) {
                let chan = deserialize(respChannel);
                await chan.connect();
                await chan.send(resp);
            }
        }

        /**
         * Add a handler for ``postMessage`` messages
         *
         * @param {Function} fn - Callback function that receives the
         * message.
         */
        addMessageHandler(fn) {
            this.messageHandlers.add(fn);
        }

        /**
         * Remove a handler for ``postMessage`` messages
         *
         * @param {Function} fn - Callback function to remove
         */
        removeMessageHandler(fn) {
            this.messageHandlers.delete(fn);
        }

        /**
         * Wait for the next ``postMessage`` message and return it
         * (after passing it to existing handlers)
         *
         * @returns {Promise} - Promise that resolves to the message.
         */
        nextMessage() {
            return new Promise(resolve => {
                let fn = (msg) => {
                    this.removeMessageHandler(fn);
                    resolve(msg);
                };
                this.addMessageHandler(fn);
            });
        }
    }

    class RemoteGlobalResponseRecvChannel {
        constructor(recvChannel) {
            this.channel = recvChannel;
            this.channel.addEventListener("message", ({data}) => this.handleMessage(data));
            this.responseHandlers = new Map();
        }

        setResponseHandler(commandId, fn) {
            this.responseHandlers.set(commandId, fn);
        }

        handleMessage(msg) {
            let {id, result} = msg;
            let handler = this.responseHandlers.get(id);
            if (handler) {
                this.responseHandlers.delete(id);
                handler(result);
            }
        }

        close() {
            return this.channel.close();
        }
    }

    /**
     * Object representing a remote global that has a
     * `RemoteGlobalCommandRecvChannel
     * <#RemoteGlobalCommandRecvChannel>`_
     */
    class RemoteGlobal {
        /**
         * Create a new RemoteGlobal object.
         *
         * This doesn't actually construct the global itself; that
         * must be done elsewhere, with a ``uuid`` query parameter in
         * its URL set to the same as the ``uuid`` property of this
         * object.
         *
         * @param {SendChannel|string} [dest] - Either a SendChannel
         * to the destination, or the UUID of the destination. If
         * ommitted, a new UUID is generated, which can be used when
         * constructing the URL for the global.
         *
         */
        constructor(dest) {
            if (!dest) {
                dest = createUuid();
            }
            if (typeof dest == "string") {
                /** UUID for the global */
                this.uuid = dest;
                this.sendChannel = new SendChannel(dest);
            } else {
                this.sendChannel = dest;
                this.uuid = dest.uuid;
            }
            this.recvChannel = null;
            this.respChannel = null;
            this.connected = false;
            this.commandId = 0;
        }

        /**
         * Connect to the channel. Automatically called when sending the
         * first message
         */
        async connect() {
            if (this.connected) {
                return;
            }
            let [recvChannel, respChannel] = self.channel();
            await Promise.all([this.sendChannel.connect(), recvChannel.connect()]);
            this.recvChannel = new RemoteGlobalResponseRecvChannel(recvChannel);
            this.respChannel = respChannel;
            this.connected = true;
        }

        async sendMessage(command, params, hasResp=true) {
            if (!this.connected) {
                await this.connect();
            }
            let msg = {id: this.commandId++, command, params};
            if (hasResp) {
                msg.respChannel = serialize(this.respChannel);
            }
            let response;
            if (hasResp) {
                response = new Promise(resolve =>
                    this.recvChannel.setResponseHandler(msg.id, resolve));
            } else {
                response = Promise.resolve(null);
            }
            this.sendChannel.send(msg);
            return await response;
        }

        /**
         * Run the function ``fn`` in the remote global, passing arguments
         * ``args``, and return the result after awaiting any returned
         * promise.
         *
         * @param {Function} fn - Function to run in the remote global.
         * @param {...Any} args  - Arguments to pass to the function
         * @returns {Promise} - Promise resolving to the return value
         * of the function.
         */
        async call(fn, ...args) {
            let result = await this.sendMessage("call", {fn: serialize(fn), args: args.map(x => serialize(x))}, true);
            if (result.exceptionDetails) {
                throw deserialize(result.exceptionDetails.exception);
            }
            return deserialize(result.result);
        }

        /**
         * Post a message to the remote
         *
         * @param {Any} msg - The message to send.
         */
        async postMessage(msg) {
            await this.sendMessage("postMessage", {msg: serialize(msg)}, false);
        }

        /**
         * Disconnect the associated `RemoteGlobalCommandRecvChannel
         * <#RemoteGlobalCommandRecvChannel>`_, if any, on the server
         * side.
         *
         * @returns {Promise} - Resolved once the channel is disconnected.
         */
        disconnectReader() {
            // This causes any readers to disconnect until they are explictly reconnected
            return this.sendChannel.disconnectReader();
        }

        /**
         * Close the channel and underlying websocket connections
         */
        close() {
            let closers = [this.sendChannel.close()];
            if (this.recvChannel !== null) {
                closers.push(this.recvChannel.close());
            }
            if (this.respChannel !== null) {
                closers.push(this.respChannel.close());
            }
            return Promise.all(closers);
        }
    }

    self.RemoteGlobal = RemoteGlobal;

    function typeName(obj) {
        let type = typeof obj;
        // The handling of cross-global objects here is broken
        if (type === "undefined" ||
            type === "string" ||
            type === "boolean" ||
            type === "number" ||
            type === "bigint" ||
            type === "symbol" ||
            type === "function") {
            return type;
        }

        if (obj === null) {
            return "null";
        }
        if (obj instanceof RemoteObject) {
            return "remoteobject";
        }
        if (obj instanceof SendChannel) {
            return "sendchannel";
        }
        if (obj instanceof RecvChannel) {
            return "recvchannel";
        }
        if (obj instanceof Error) {
            return "error";
        }
        if (Array.isArray(obj)) {
            return "array";
        }
        let constructor = obj.constructor && obj.constructor.name;
        if (constructor === "RegExp" ||
            constructor === "Date" ||
            constructor === "Map" ||
            constructor === "Set" ||
            constructor == "WeakMap" ||
            constructor == "WeakSet") {
            return constructor.toLowerCase();
        }
        // The handling of cross-global objects here is broken
        if (typeof window == "object" && window === self) {
            if (obj instanceof Element) {
                return "element";
            }
            if (obj instanceof Document) {
                return "document";
            }
            if (obj instanceof Node) {
                return "node";
            }
            if (obj instanceof Window) {
                return "window";
            }
        }
        if (Promise.resolve(obj) === obj) {
            return "promise";
        }
        return "object";
    }

    let remoteObjectsById = new Map();

    function remoteId(obj) {
        let rv;
        rv = createUuid();
        remoteObjectsById.set(rv, obj);
        return rv;
    }

    /**
     * Representation of a non-primitive type passed through a channel
     */
    class RemoteObject {
        constructor(type, objectId) {
            this.type = type;
            this.objectId = objectId;
        }

        /**
         * Create a RemoteObject containing a handle to reference obj
         *
         * @param {Any} obj - The object to reference.
         */
        static from(obj) {
            let type = typeName(obj);
            let id = remoteId(obj);
            return new RemoteObject(type, id);
        }

        /**
         * Return the local object referenced by the ``objectId`` of
         * this ``RemoteObject``, or ``null`` if there isn't a such an
         * object in this realm.
         */
        toLocal() {
            if (remoteObjectsById.has(this.objectId)) {
                return remoteObjectsById.get(this.objectId);
            }
            return null;
        }

        /**
         * Remove the object from the local cache. This means that future
         * calls to ``toLocal`` with the same objectId will always return
         * ``null``.
         */
        delete() {
            if (remoteObjectsById.has(this.objectId)) {
                remoteObjectsById.delete(this.objectId);
            }
        }
    }

    self.RemoteObject = RemoteObject;

    function serialize(obj) {
        const stack = [{item: obj}];
        let serialized = null;

        // Map from container object input to output value
        let objectsSeen = new Map();
        let lastObjectId = 0;

        while (stack.length > 0) {
            const {item, target, targetKey} = stack.shift();
            let type = typeName(item);
            let value;
            let objectId;
            let newTarget;

            if (objectsSeen.has(item)) {
                let outputValue = objectsSeen.get(item);
                if (!outputValue.hasOwnProperty("objectId")) {
                    outputValue.objectId = lastObjectId++;
                }
                objectId = outputValue.objectId;
            } else {
                switch (type) {
                case "undefined":
                case "null":
                    break;
                case "string":
                case "boolean":
                    value = item;
                    break;
                case "number":
                    if (item !== item) {
                        value = "NaN";
                    } else if (item === 0 && 1/item == Number.NEGATIVE_INFINITY) {
                        value = "-0";
                    } else if (item === Number.POSITIVE_INFINITY) {
                        value = "+Infinity";
                    } else if (item === Number.NEGATIVE_INFINITY) {
                        value = "-Infinity";
                    } else {
                        value = item;
                    }
                    break;
                case "bigint":
                case "function":
                    value = obj.toString();
                    break;
                case "remoteobject":
                    value = {
                        type: obj.type,
                        objectId: obj.objectId
                    };
                    break;
                case "sendchannel":
                    value = item.uuid;
                    break;
                case "regexp":
                    value = {
                        pattern:item.source,
                        flags: item.flags
                    };
                    break;
                case "date":
                    value = Date.prototype.toJSON.call(item);
                    break;
                case "error":
                    value = {
                        type: item.constructor.name,
                        name: item.name,
                        message: item.message,
                        lineNumber: item.lineNumber,
                        columnNumber: item.columnNumber,
                        fileName: item.fileName,
                        stack: item.stack,
                    };
                    break;
                case "array":
                case "set":
                    value = [];
                    newTarget = {type: "array", value};
                    for (let child of item) {
                        stack.push({item: child, target: newTarget});
                    }
                    break;
                case "object":
                    value = {};
                    newTarget = {type: "object", value};
                    for (let [targetKey, child] of Object.entries(item)) {
                        stack.push({item: child, target: newTarget, targetKey});
                    }
                    break;
                case "map":
                    value = [];
                    newTarget = {type: "map", value};
                    for (let [targetKey, child] of item.entries()) {
                        stack.push({item: targetKey, target: newTarget, targetKey: "key"});
                        stack.push({item: child, target: newTarget, targetKey: "value"});
                    }
                    break;
                default:
                    throw new TypeError(`Can't serialize value of type ${type}; consider using RemoteObject.from() to wrap the object`);
                };
            }
            let result = {type};
            if (value !== undefined) {
                result.value = value;
            }
            if (objectId !== undefined) {
                result.objectId = objectId;
            } else {
                objectsSeen.set(item, result);
            }
            if (!target) {
                if (serialized !== null) {
                    throw new Error("Tried to create multiple output values");
                }
                serialized = result;
            } else {
                switch (target.type) {
                case "array":
                    target.value.push(result);
                    break;
                case "object":
                    target.value[targetKey] = result;
                    break;
                case "map":
                    if (targetKey === "key") {
                        target.value.push([]);
                    }
                    target.value[target.value.length - 1].push(result);
                    break;
                default:
                    throw new Error(`Unknown target type ${target.type}`);
                }
            }
        }
        return serialized;
    }

    function deserialize(obj) {
        let deserialized = null;
        let stack = [{item: obj, target: null}];
        let objectMap = new Map();

        while (stack.length > 0) {
            const {item, target, targetKey} = stack.shift();
            const {type, value, objectId} = item;
            let result;
            let newTarget;
            if (objectId !== undefined && value === undefined) {
                result = objectMap.get(objectId);
            } else {
                switch(type) {
                case "undefined":
                    result = undefined;
                    break;
                case "null":
                    result = null;
                    break;
                case "string":
                case "boolean":
                    result = value;
                    break;
                case "number":
                    if (typeof value === "string") {
                        switch(value) {
                        case "NaN":
                            result = NaN;
                            break;
                        case "-0":
                            result = -0;
                            break;
                        case "+Infinity":
                            result = Number.POSITIVE_INFINITY;
                            break;
                        case "-Infinity":
                            result = Number.NEGATIVE_INFINITY;
                            break;
                        default:
                            throw new Error(`Unexpected number value "${value}"`);
                        }
                    } else {
                        result = value;
                    }
                    break;
                case "bigint":
                    result = BigInt(value);
                    break;
                case "function":
                    result = new Function("...args", `return (${value}).apply(null, args)`);
                    break;
                case "remoteobject":
                    let remote = new RemoteObject(value.type, value.objectId);
                    let local = remote.toLocal();
                    if (local !== null) {
                        result = local;
                    } else {
                        result = remote;
                    }
                    break;
                case "sendchannel":
                    result = new SendChannel(value);
                    break;
                case "regexp":
                    result = new RegExp(value.pattern, value.flags);
                    break;
                case "date":
                    result = new Date(value);
                    break;
                case "error":
                    if (item.value.type in self &&
                        typeof self[item.value.type] === "function") {
                        result = new self[item.value.type](item.value.message);
                    } else {
                        result = new Error(item.value.message);
                    }
                    result.name = item.value.name;
                    result.lineNumber = item.value.lineNumber;
                    result.columnNumber = item.value.columnNumber;
                    result.fileName = item.value.fileName;
                    result.stack = item.value.stack;
                    break;
                case "array":
                    result = [];
                    newTarget = {type: "array", value: result};
                    for (let child of value) {
                        stack.push({item: child, target: newTarget});
                    }
                    break;
                case "set":
                    result = new Set();
                    newTarget = {type: "set", value: result};
                    for (let child of value) {
                        stack.push({item: child, target: newTarget});
                    }
                    break;
                case "object":
                    result = {};
                    newTarget = {type: "object", value: result};
                    for (let [targetKey, child] of Object.entries(value)) {
                        stack.push({item: child, target: newTarget, targetKey});
                    }
                    break;
                case "map":
                    result = new Map();
                    newTarget = {type: "map", value: result};
                    for (let [key, child] of value) {
                        stack.push({item: key, target: newTarget, targetKey: "key"});
                        stack.push({item: child, target: newTarget, targetKey: "value"});
                    }
                    break;
                default:
                    throw new TypeError(`Can't deserialize object of type ${type}`);
                }
                if (objectId !== undefined) {
                    objectMap.set(objectId, result);
                }
            }

            if (target === null) {
                if (deserialized !== null) {
                    throw new Error("Tried to create multiple output values");
                }
                deserialized = result;
            } else {
                switch(target.type) {
                case "array":
                    target.value.push(result);
                    break;
                case "set":
                    target.value.add(result);
                    break;
                case "object":
                    target.value[targetKey] = result;
                    break;
                case "map":
                    if (targetKey === "key") {
                        target.key = result;
                    } else {
                        target.value.set(target.key, result);
                    }
                    break;
                default:
                    throw new Error(`Unknown target type ${target.type}`);
                }
            }
        }
        return deserialized;
    }
})();
