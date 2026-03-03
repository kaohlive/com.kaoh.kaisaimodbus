'use strict';

const Homey = require('homey');
const ModbusClient = require('../../api/ModbusClient');

class KaisaiAWHPDriver extends Homey.Driver {

  // Kaisai operation modes (Holding register 1)
  OPERATION_MODES = {
    1: 'auto',
    2: 'cool',
    3: 'heat'
  };

  // Kaisai ODU cycle states (Holding register 101)
  ODU_CYCLES = {
    0: 'standby',
    2: 'cooling',
    3: 'heating'
  };

  async onInit() {
    this.log('KaisaiAWHPDriver has been initialized');

    // Register flow card conditions
    this.registerFlowCardConditions();

    // Register flow card actions
    this.registerFlowCardActions();
  }

  registerFlowCardConditions() {
    // ODU cycle is condition
    this.homey.flow.getConditionCard('odu_cycle_is')
      .registerRunListener(async (args) => {
        return await args.device.conditionOduCycleIs(args);
      });

    // Is heating condition
    this.homey.flow.getConditionCard('is_heating')
      .registerRunListener(async (args) => {
        return await args.device.conditionIsHeating();
      });

    // Is cooling condition
    this.homey.flow.getConditionCard('is_cooling')
      .registerRunListener(async (args) => {
        return await args.device.conditionIsCooling();
      });

    // Is defrosting condition
    this.homey.flow.getConditionCard('is_defrosting')
      .registerRunListener(async (args) => {
        return await args.device.conditionIsDefrosting();
      });

    // Compressor is on condition
    this.homey.flow.getConditionCard('compressor_is_on')
      .registerRunListener(async (args) => {
        return await args.device.conditionCompressorIsOn();
      });

    // DHW is active condition
    this.homey.flow.getConditionCard('dhw_is_active')
      .registerRunListener(async (args) => {
        return await args.device.conditionDhwIsActive();
      });

    // Temperature above condition
    this.homey.flow.getConditionCard('temperature_above')
      .registerRunListener(async (args) => {
        return await args.device.conditionTemperatureAbove(args);
      });
  }

  registerFlowCardActions() {
    // Set DHW target temperature action
    this.homey.flow.getActionCard('set_dhw_target_temperature')
      .registerRunListener(async (args) => {
        return await args.device.actionSetDhwTargetTemperature(args);
      });

    // Enable DHW action
    this.homey.flow.getActionCard('enable_dhw')
      .registerRunListener(async (args) => {
        return await args.device.actionEnableDhw();
      });

    // Disable DHW action
    this.homey.flow.getActionCard('disable_dhw')
      .registerRunListener(async (args) => {
        return await args.device.actionDisableDhw();
      });

    // Enable silent mode action
    this.homey.flow.getActionCard('enable_silent_mode')
      .registerRunListener(async (args) => {
        return await args.device.actionEnableSilentMode();
      });

    // Disable silent mode action
    this.homey.flow.getActionCard('disable_silent_mode')
      .registerRunListener(async (args) => {
        return await args.device.actionDisableSilentMode();
      });
  }

  async onPair(session) {
    session.setHandler('test_connection', async (data) => {
      this.log(`Testing connection to ${data.ip}:${data.port} (slave ${data.slave_id})`);

      const client = new ModbusClient();
      try {
        const connected = await client.connect({ ip: data.ip, port: data.port });
        if (!connected) {
          return { success: false, message: 'Could not connect to gateway' };
        }

        // Try reading register 1 (mode) to verify Kaisai heat pump responds
        await client.readHoldingRegisters(data.slave_id, 1, 1);
        client.disconnect();

        this.log('Connection test successful');
        return { success: true };
      } catch (err) {
        this.log('Connection test failed:', err.message);
        client.disconnect();
        return { success: false, message: err.message };
      }
    });
  }
}

module.exports = KaisaiAWHPDriver;
