'use strict';

const modbus = require('modbus-stream');
const EventEmitter = require('events');

class ModbusClient extends EventEmitter {
  constructor() {
    super();
    this.connection = null;
    this.connected = false;
    this.connectionTimeout = 5000;
    this.reconnectInterval = null;
    this.config = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.maxReconnectDelay = 60000;
    this.isReconnecting = false;
  }

  async connect(config) {
    this.config = config;

    try {
      if (this.connection) {
        try {
          if (this.socket && !this.socket.destroyed) {
            this.socket.end();
          }
        } catch (err) {
          console.log('Error closing existing connection:', err.message);
        }
        this.connection = null;
        this.socket = null;
      }

      this.connection = await new Promise((resolve, reject) => {
        const connectTimeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, this.connectionTimeout);

        modbus.tcp.connect(config.port || 502, config.ip, { debug: null }, (err, connection) => {
          clearTimeout(connectTimeout);
          if (err) return reject(err);
          resolve(connection);
        });
      });

      this.connected = true;
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      this.emit('connect');

      this.socket = this.connection?.transport?.stream;
      if (this.socket) {
        this.socket.setTimeout(this.connectionTimeout);
      }

      this.setupConnectionHandlers();
      return true;
    } catch (error) {
      this.connected = false;
      this.emit('error', error);
      return false;
    }
  }

  setupConnectionHandlers() {
    if (!this.connection) return;

    this.connection.on('error', (error) => {
      console.log('Connection error:', error.message);
      this.connected = false;
      this.emit('error', error);

      if (error.code === 'ERR_BUFFER_OUT_OF_BOUNDS' ||
          error.message.includes('buffer') ||
          error.message.includes('outside buffer') ||
          error.message.includes('Transport') ||
          error.name === 'RangeError') {
        this.forceReconnect();
      } else {
        this.scheduleReconnect();
      }
    });

    this.connection.on('close', () => {
      this.connected = false;
      this.emit('close');
      this.scheduleReconnect();
    });

    this.connection.on('timeout', () => {
      console.log('Socket timeout detected');
    });

    try {
      if (this.socket) {
        this.socket.on('error', (error) => {
          console.log('Socket error:', error.message);
          this.connected = false;
          this.emit('error', error);
        });
      }

      if (this.connection.transport) {
        this.connection.transport.on('error', (error) => {
          console.log('Transport layer error:', error.message);
          this.connected = false;
          this.forceReconnect();
        });
      }

      if (this.connection.transport && this.connection.transport.stream) {
        this.connection.transport.stream.on('error', (error) => {
          console.log('Transport stream error:', error.message);
          this.connected = false;
          if (error.code === 'ERR_BUFFER_OUT_OF_BOUNDS' ||
              error.message.includes('buffer bounds') ||
              error.message.includes('outside buffer')) {
            this.forceReconnect();
          }
        });
      }
    } catch (err) {
      console.log('Error setting up socket/transport handlers:', err.message);
    }
  }

  scheduleReconnect() {
    if (this.reconnectInterval || this.isReconnecting) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('Max reconnection attempts reached.');
      this.emit('error', new Error('Max reconnection attempts reached'));
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );

    console.log(`Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

    this.reconnectInterval = setTimeout(async () => {
      this.reconnectInterval = null;
      if (this.config) {
        const success = await this.connect(this.config);
        if (!success) {
          this.isReconnecting = false;
          this.scheduleReconnect();
        }
      } else {
        this.isReconnecting = false;
      }
    }, delay);
  }

  clearReconnectInterval() {
    if (this.reconnectInterval) {
      clearTimeout(this.reconnectInterval);
      this.reconnectInterval = null;
    }
  }

  forceReconnect() {
    console.log('Forcing immediate reconnection due to transport error');
    this.clearReconnectInterval();
    this.isReconnecting = false;

    try {
      if (this.socket && !this.socket.destroyed) {
        this.socket.destroy();
      }
    } catch (err) {
      console.log('Error destroying socket:', err.message);
    }

    this.connection = null;
    this.socket = null;
    this.connected = false;

    setTimeout(() => {
      if (this.config) {
        this.connect(this.config);
      }
    }, 1000);
  }

  // ============================================
  // MODBUS READ OPERATIONS
  // ============================================

  async readHoldingRegisters(slaveId, address, quantity, retries = 2) {
    if (!this.connected || !this.connection) {
      throw new Error('Modbus not connected');
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`Read holding registers timeout (slave=${slaveId}, addr=${address}, qty=${quantity})`));
          }, this.connectionTimeout);

          this.connection.readHoldingRegisters({
            address,
            quantity,
            extra: { unitId: slaveId || 2 }
          }, (err, info) => {
            clearTimeout(timeout);
            if (err) reject(err);
            else resolve(info.response.data);
          });
        });

        return result;
      } catch (err) {
        if (err.code === 'ERR_BUFFER_OUT_OF_BOUNDS' ||
            err.name === 'RangeError' ||
            err.message.includes('buffer bounds') ||
            err.message.includes('outside buffer')) {
          this.forceReconnect();
          throw new Error('Transport error - reconnecting');
        }

        if (attempt < retries) {
          console.log(`Read holding failed (attempt ${attempt + 1}/${retries + 1}), retrying...`, err.message);
          if (!this.connected || !this.connection) {
            throw new Error('Connection lost during retry');
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          throw err;
        }
      }
    }
  }

  async readInputRegisters(slaveId, address, quantity, retries = 2) {
    if (!this.connected || !this.connection) {
      throw new Error('Modbus not connected');
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`Read input registers timeout (slave=${slaveId}, addr=${address}, qty=${quantity})`));
          }, this.connectionTimeout);

          this.connection.readInputRegisters({
            address,
            quantity,
            extra: { unitId: slaveId || 2 }
          }, (err, info) => {
            clearTimeout(timeout);
            if (err) reject(err);
            else resolve(info.response.data);
          });
        });

        return result;
      } catch (err) {
        if (err.code === 'ERR_BUFFER_OUT_OF_BOUNDS' ||
            err.name === 'RangeError') {
          this.forceReconnect();
          throw new Error('Transport error - reconnecting');
        }

        if (attempt < retries) {
          console.log(`Read input failed (attempt ${attempt + 1}/${retries + 1}), retrying...`, err.message);
          if (!this.connected || !this.connection) {
            throw new Error('Connection lost during retry');
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          throw err;
        }
      }
    }
  }

  async readCoils(slaveId, address, quantity, retries = 2) {
    if (!this.connected || !this.connection) {
      throw new Error('Modbus not connected');
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`Read coils timeout (slave=${slaveId}, addr=${address}, qty=${quantity})`));
          }, this.connectionTimeout);

          this.connection.readCoils({
            address,
            quantity,
            extra: { unitId: slaveId || 2 }
          }, (err, info) => {
            clearTimeout(timeout);
            if (err) reject(err);
            else resolve(info.response.data);
          });
        });

        return result;
      } catch (err) {
        if (err.code === 'ERR_BUFFER_OUT_OF_BOUNDS' ||
            err.name === 'RangeError') {
          this.forceReconnect();
          throw new Error('Transport error - reconnecting');
        }

        if (attempt < retries) {
          console.log(`Read coils failed (attempt ${attempt + 1}/${retries + 1}), retrying...`, err.message);
          if (!this.connected || !this.connection) {
            throw new Error('Connection lost during retry');
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          throw err;
        }
      }
    }
  }

  async readDiscreteInputs(slaveId, address, quantity, retries = 2) {
    if (!this.connected || !this.connection) {
      throw new Error('Modbus not connected');
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`Read discrete inputs timeout (slave=${slaveId}, addr=${address}, qty=${quantity})`));
          }, this.connectionTimeout);

          this.connection.readDiscreteInputs({
            address,
            quantity,
            extra: { unitId: slaveId || 2 }
          }, (err, info) => {
            clearTimeout(timeout);
            if (err) reject(err);
            else resolve(info.response.data);
          });
        });

        return result;
      } catch (err) {
        if (err.code === 'ERR_BUFFER_OUT_OF_BOUNDS' ||
            err.name === 'RangeError') {
          this.forceReconnect();
          throw new Error('Transport error - reconnecting');
        }

        if (attempt < retries) {
          console.log(`Read discrete failed (attempt ${attempt + 1}/${retries + 1}), retrying...`, err.message);
          if (!this.connected || !this.connection) {
            throw new Error('Connection lost during retry');
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          throw err;
        }
      }
    }
  }

  // ============================================
  // MODBUS WRITE OPERATIONS
  // ============================================

  async writeSingleRegister(slaveId, address, value, retries = 2) {
    if (!this.connected || !this.connection) {
      throw new Error('Modbus not connected');
    }

    const bufferValue = Buffer.allocUnsafe(2);
    bufferValue.writeUInt16BE(value, 0);

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Write operation timeout'));
          }, this.connectionTimeout);

          this.connection.writeSingleRegister({
            address,
            value: bufferValue,
            extra: { unitId: slaveId || 2 }
          }, (err, info) => {
            clearTimeout(timeout);
            if (err) reject(err);
            else resolve(info);
          });
        });

        return result;
      } catch (err) {
        if (err.code === 'ERR_BUFFER_OUT_OF_BOUNDS' ||
            err.name === 'RangeError') {
          this.forceReconnect();
          throw new Error('Transport error - reconnecting');
        }

        if (attempt < retries) {
          console.log(`Write register failed (attempt ${attempt + 1}/${retries + 1}), retrying...`, err.message);
          if (!this.connected || !this.connection) {
            throw new Error('Connection lost during retry');
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          throw err;
        }
      }
    }
  }

  async writeSingleCoil(slaveId, address, value, retries = 2) {
    if (!this.connected || !this.connection) {
      throw new Error('Modbus not connected');
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Write coil timeout'));
          }, this.connectionTimeout);

          this.connection.writeSingleCoil({
            address,
            value: value ? 0xFF00 : 0x0000,
            extra: { unitId: slaveId || 2 }
          }, (err, info) => {
            clearTimeout(timeout);
            if (err) reject(err);
            else resolve(info);
          });
        });

        return result;
      } catch (err) {
        if (err.code === 'ERR_BUFFER_OUT_OF_BOUNDS' ||
            err.name === 'RangeError') {
          this.forceReconnect();
          throw new Error('Transport error - reconnecting');
        }

        if (attempt < retries) {
          console.log(`Write coil failed (attempt ${attempt + 1}/${retries + 1}), retrying...`, err.message);
          if (!this.connected || !this.connection) {
            throw new Error('Connection lost during retry');
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          throw err;
        }
      }
    }
  }

  // ============================================
  // CONNECTION MANAGEMENT
  // ============================================

  isConnected() {
    return this.connected;
  }

  disconnect() {
    this.clearReconnectInterval();
    this.isReconnecting = false;
    this.reconnectAttempts = 0;

    if (this.connection && this.socket && !this.socket.destroyed) {
      this.socket.end();
    }

    this.connected = false;
    this.connection = null;
    this.socket = null;
    this.config = null;
  }

  // ============================================
  // UTILITY FUNCTIONS
  // ============================================

  static bufferToUint16(buffer, littleEndian = false) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 2) {
      throw new Error('Buffer must be at least 2 bytes for uint16');
    }
    return littleEndian ? buffer.readUInt16LE(0) : buffer.readUInt16BE(0);
  }

  static bufferToInt16(buffer, littleEndian = false) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 2) {
      throw new Error('Buffer must be at least 2 bytes for int16');
    }
    return littleEndian ? buffer.readInt16LE(0) : buffer.readInt16BE(0);
  }

  static bufferToUint32(buffer, littleEndian = false) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
      throw new Error('Buffer must be at least 4 bytes for uint32');
    }
    return (littleEndian ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0)) >>> 0;
  }

  static bufferToInt32(buffer, littleEndian = false) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
      throw new Error('Buffer must be at least 4 bytes for int32');
    }
    return littleEndian ? buffer.readInt32LE(0) : buffer.readInt32BE(0);
  }

  /**
   * Extract a single bit from a coils response buffer
   * Coils response data is a buffer of bytes, each bit representing one coil
   * @param {Buffer} buffer - Buffer from coils response
   * @param {number} bitIndex - Zero-based bit index within the response
   * @returns {boolean} - true if coil is ON
   */
  static getCoilValue(buffer, bitIndex = 0) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error('Invalid buffer for coil value');
    }
    const byteIndex = Math.floor(bitIndex / 8);
    const bitOffset = bitIndex % 8;
    return (buffer[byteIndex] & (1 << bitOffset)) !== 0;
  }
}

module.exports = ModbusClient;
