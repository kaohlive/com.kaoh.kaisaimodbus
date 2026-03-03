'use strict';

const Homey = require('homey');
const ModbusClient = require('./api/ModbusClient');

module.exports = class KaisaiModbusApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Kaisai Modbus App has been initialized');

    // Handle uncaught exceptions from modbus-stream library
    // These can occur when the device sends malformed/truncated responses
    process.on('uncaughtException', (error) => {
      if (error.code === 'ERR_BUFFER_OUT_OF_BOUNDS' ||
          error.name === 'RangeError' ||
          (error.message && error.message.includes('buffer'))) {
        this.log('Caught uncaught buffer exception from Modbus transport - this is expected when device sends malformed data');
        // Don't crash - the ModbusClient will handle reconnection
      } else {
        // Re-throw other uncaught exceptions
        this.error('Uncaught exception:', error);
        throw error;
      }
    });

    // Create a dedicated Modbus client for testing
    this.testModbus = new ModbusClient();
  }

  /**
   * Get all Kaisai AWHP devices
   */
  getKaisaiDevices() {
    const driver = this.homey.drivers.getDriver('kaisai-awhp');
    if (!driver) {
      return [];
    }

    const devices = driver.getDevices();
    return devices.map(device => ({
      id: device.getData().id,
      name: device.getName(),
      ip: device.getSetting('ip'),
      port: device.getSetting('port'),
      slaveId: device.getSetting('slave_id')
    }));
  }

  /**
   * Get a Kaisai device by its ID
   */
  getKaisaiDeviceById(deviceId) {
    const driver = this.homey.drivers.getDriver('kaisai-awhp');
    if (!driver) {
      return null;
    }

    const devices = driver.getDevices();
    return devices.find(device => device.getData().id === deviceId);
  }

  /**
   * Read a Modbus register from a device
   */
  async readRegister(deviceId, address, count = 1) {
    const device = this.getKaisaiDeviceById(deviceId);
    if (!device) {
      throw new Error('Device not found');
    }

    const settings = device.getSettings();
    const ip = settings.ip;
    const port = settings.port || 502;
    const slaveId = settings.slave_id || 1;

    try {
      await this.testModbus.connect({ ip, port });
      const result = await this.testModbus.readHoldingRegisters(slaveId, address, count);
      const buffer = Buffer.concat(result);

      const response = {
        success: true,
        address: address,
        count: count,
        raw: Array.from(buffer),
        uint16: ModbusClient.bufferToUint16(buffer),
        int16: ModbusClient.bufferToInt16(buffer),
        hex: buffer.toString('hex').toUpperCase()
      };

      if (count >= 2) {
        response.uint32 = ModbusClient.bufferToUint32(buffer);
        response.int32 = ModbusClient.bufferToInt32(buffer);
      }

      return response;
    } catch (error) {
      this.error('Error reading register:', error);
      return { success: false, error: error.message };
    } finally {
      this.testModbus.disconnect();
    }
  }

  /**
   * Write a value to a Modbus register
   */
  async writeRegister(deviceId, address, value) {
    const device = this.getKaisaiDeviceById(deviceId);
    if (!device) {
      throw new Error('Device not found');
    }

    const settings = device.getSettings();
    const ip = settings.ip;
    const port = settings.port || 502;
    const slaveId = settings.slave_id || 1;

    try {
      await this.testModbus.connect({ ip, port });
      await this.testModbus.writeSingleRegister(slaveId, address, value);
      this.log(`Successfully wrote value ${value} to register ${address}`);
      return { success: true, address: address, value: value };
    } catch (error) {
      this.error('Error writing register:', error);
      return { success: false, error: error.message };
    } finally {
      this.testModbus.disconnect();
    }
  }
};
