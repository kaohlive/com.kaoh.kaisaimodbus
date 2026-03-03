'use strict';

const Homey = require('homey');
const ModbusClient = require('../../api/ModbusClient');

class KaisaiAWHPDevice extends Homey.Device {

  async onInit() {
    this.log('Kaisai AWHP Device has been initialized');

    // Track if device is being deleted to prevent operations on deleted device
    this._isDeleted = false;

    // Get device settings
    this.settings = this.getSettings();

    // Initialize Modbus client
    this.modbus = new ModbusClient();

    // Apply connection timeout setting to ModbusClient
    if (this.settings.connection_timeout) {
      this.modbus.connectionTimeout = this.settings.connection_timeout;
    }

    // Previous values for event detection
    this.previousValues = {};

    // Error tracking for graceful degradation
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = this.settings.max_consecutive_errors || 3;

    // Cache for register values (needed for read-modify-write bitfield operations)
    this._registerCache = {};

    // Setup Modbus event handlers
    this.setupModbusHandlers();

    // Fix missing capabilities
    await this.repairCapabilities();

    // Start polling
    this.startPolling();

    // Register capability listeners for writable capabilities
    this.setupCapabilityListeners();

    // Register flow trigger cards
    this.registerFlowCardTriggers();

    // Energy accumulation tracking
    this._lastPollTime = null;
    this._thermalEnergy = this.getStoreValue('thermal_energy') || 0;
  }

  async repairCapabilities() {
    const requiredCapabilities = [
      'onoff',
      'target_temperature',
      'thermostat_mode',
      'measure_temperature',
      'measure_temperature.water_outlet',
      'measure_temperature.water_inlet',
      'measure_temperature.outdoor',
      'measure_temperature.room',
      'silent_mode',
      'odu_cycle',
      'measure_power',
      'meter_power',
      'measure_power.heat',
      'meter_power.heat',
      'measure_cop',
      'measure_water',
      'alarm_generic',
      'error_code',
      'compressor_status',
      'defrosting_status',
      'water_pump_status'
    ];

    for (const cap of requiredCapabilities) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap);
        this.log(`Registered missing ${cap} capability`);
      }
    }

    // Add/remove optional feature capabilities based on settings
    await this.updateOptionalCapabilities('dhw_installed', [
      'measure_temperature.dhw', 'target_temperature.dhw', 'dhw_enabled', 'dhw_heating_status'
    ]);
    await this.updateOptionalCapabilities('backup_heater_installed', [
      'measure_temperature.backup_heater'
    ]);
  }

  async updateOptionalCapabilities(settingKey, capabilities) {
    const enabled = this.settings[settingKey] !== false;
    for (const cap of capabilities) {
      if (enabled && !this.hasCapability(cap)) {
        await this.addCapability(cap);
        this.log(`Added capability: ${cap}`);
      } else if (!enabled && this.hasCapability(cap)) {
        await this.removeCapability(cap);
        this.log(`Removed capability: ${cap}`);
      }
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys);

    // Update settings
    this.settings = newSettings;

    // Apply connection timeout changes
    if (changedKeys.includes('connection_timeout')) {
      this.modbus.connectionTimeout = newSettings.connection_timeout;
      this.log(`Connection timeout updated to ${newSettings.connection_timeout}ms`);
    }

    // Apply max consecutive errors changes
    if (changedKeys.includes('max_consecutive_errors')) {
      this.maxConsecutiveErrors = newSettings.max_consecutive_errors;
      this.log(`Max consecutive errors updated to ${newSettings.max_consecutive_errors}`);
    }

    // Toggle optional capabilities based on feature settings
    if (changedKeys.includes('dhw_installed')) {
      await this.updateOptionalCapabilities('dhw_installed', [
        'measure_temperature.dhw', 'target_temperature.dhw', 'dhw_enabled', 'dhw_heating_status'
      ]);
    }
    if (changedKeys.includes('backup_heater_installed')) {
      await this.updateOptionalCapabilities('backup_heater_installed', [
        'measure_temperature.backup_heater'
      ]);
    }

    // Restart polling if connection settings changed
    if (changedKeys.includes('ip') || changedKeys.includes('port') || changedKeys.includes('slave_id') || changedKeys.includes('poll_interval')) {
      this.restartPolling();
    }
  }

  setupModbusHandlers() {
    this.modbus.on('connect', () => {
      this.setAvailable();
      this.consecutiveErrors = 0;
      this._staticInfoLoaded = false;
      this.log('Connected to Modbus device');
    });

    this.modbus.on('error', (error) => {
      this.log('Modbus connection error:', error.message);
    });

    this.modbus.on('close', () => {
      this.log('Modbus connection closed - will attempt reconnection');
    });
  }

  async connectModbus() {
    if (this.modbus.isConnected()) {
      return true;
    }

    try {
      this.log(`Connecting to ${this.settings.ip}:${this.settings.port || 502} (slave ${this.settings.slave_id || 1})...`);
      const success = await this.modbus.connect({
        ip: this.settings.ip,
        port: this.settings.port || 502
      });

      if (success) {
        this.log('TCP connection established');
      }
      return success;
    } catch (error) {
      this.log('Modbus connection failed:', error);
      return false;
    }
  }

  disconnectModbus() {
    if (this.modbus) {
      this.modbus.disconnect();
      this.log('Disconnected from Modbus device');
    }
  }

  startPolling() {
    this.stopPolling();

    const interval = (this.settings.poll_interval || 60) * 1000;
    this.pollInterval = setInterval(async () => {
      await this.pollData();
    }, interval);

    // Initial poll
    setTimeout(() => this.pollData(), 1000);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  restartPolling() {
    this.stopPolling();
    this.disconnectModbus();
    this.log(`Reconnecting to ${this.settings.ip}:${this.settings.port || 502}`);
    this.startPolling();
  }

  // Read static device info on first connect (appliance type from register 200)
  async processDeviceStaticInfo(slaveId) {
    try {
      const result = await this.modbus.readHoldingRegisters(slaveId, 200, 1);
      const buffer = Buffer.concat(result);
      const applianceType = ModbusClient.bufferToUint16(buffer);

      const upperByte = (applianceType >> 8) & 0xFF;
      const midNibble = (applianceType >> 4) & 0x0F;
      const lowNibble = applianceType & 0x0F;

      let typeStr = 'Unknown';
      if (upperByte === 0x07) typeStr = 'Air to Water Heat Pump';

      let subType = '';
      if ((lowNibble & 0x02) !== 0) subType = ' (R32)';

      this.log(`Appliance type: 0x${applianceType.toString(16).toUpperCase()} - ${typeStr}${subType}`);

      this.setSettings({
        'appliance_type': `${typeStr}${subType} (0x${applianceType.toString(16).toUpperCase()})`
      }).catch(this.error);
    } catch (error) {
      this.log('Device static info error:', error);
    }
  }

  async pollData() {
    if (this._isDeleted) {
      return;
    }

    // Prevent concurrent polls through the serial gateway
    if (this._polling) {
      this.log('Poll already in progress, skipping');
      return;
    }
    this._polling = true;

    if (!await this.connectModbus()) {
      this._polling = false;
      this.consecutiveErrors++;
      this.log(`Connection failed (${this.consecutiveErrors}/${this.maxConsecutiveErrors})`);

      if (this.consecutiveErrors >= this.maxConsecutiveErrors && !this._isDeleted) {
        this.setUnavailable(`Connection failed after ${this.maxConsecutiveErrors} attempts`);
      }
      return;
    }

    try {
      const slaveId = this.settings.slave_id || 1;

      // Small delay helper - serial gateway needs time between requests
      const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

      // Read 1: Control registers 0-10 (writable settings)
      this.log('Polling control registers...');
      await this.processControlRegisters(slaveId);
      await delay(500);

      // Read 2: Running parameters 100-147 (read-only sensors)
      this.log('Polling running parameters...');
      await this.processRunningParameters(slaveId);

      // Load static device info after critical reads succeed (non-essential)
      if (!this._staticInfoLoaded) {
        await delay(500);
        this.log('Loading static device info...');
        await this.processDeviceStaticInfo(slaveId);
        this._staticInfoLoaded = true;
      }

      // Successful poll - reset error counter
      this.consecutiveErrors = 0;
      if (!this._isDeleted && !this.getAvailable()) {
        this.setAvailable();
      }

    } catch (error) {
      this.consecutiveErrors++;
      this.log(`Polling error (${this.consecutiveErrors}/${this.maxConsecutiveErrors}):`, error.message);

      if (this.consecutiveErrors >= this.maxConsecutiveErrors && !this._isDeleted) {
        this.setUnavailable(`Polling failed ${this.maxConsecutiveErrors} times: ${error.message}`);
      }
    } finally {
      this._polling = false;
    }
  }

  // ============================================
  // CONTROL REGISTERS (FC 0x03) - Registers 0-10
  // Writable settings: power, mode, targets, functions
  // ============================================
  async processControlRegisters(slaveId) {
    try {
      // Read 11 holding registers starting at address 0
      const result = await this.modbus.readHoldingRegisters(slaveId, 0, 11);
      const buffer = Buffer.concat(result);

      // Cache register values for read-modify-write operations
      this._registerCache[0] = ModbusClient.bufferToUint16(buffer.subarray(0, 2));
      this._registerCache[5] = ModbusClient.bufferToUint16(buffer.subarray(10, 12));

      // Register 0: Power on/off bitfield
      const powerReg = this._registerCache[0];
      // BIT0 = AC zone1 (room temp control), BIT1 = floor heating zone1
      // Consider "on" if any zone1 heating/cooling is active
      const isOn = (powerReg & 0x03) !== 0;
      const prevOn = this.getCapabilityValue('onoff');
      if (prevOn !== isOn) {
        this.setCapabilityValue('onoff', isOn).catch(this.error);
      }

      // BIT2 = DHW enabled
      if (this.hasCapability('dhw_enabled')) {
        const dhwEnabled = (powerReg & 0x04) !== 0;
        const prevDhwEnabled = this.getCapabilityValue('dhw_enabled');
        if (prevDhwEnabled !== dhwEnabled) {
          this.setCapabilityValue('dhw_enabled', dhwEnabled).catch(this.error);
        }
      }

      // Register 1: Operation mode (1=Auto, 2=Cool, 3=Heat)
      const modeRaw = ModbusClient.bufferToUint16(buffer.subarray(2, 4));
      const modeStr = this.driver.OPERATION_MODES[modeRaw] || 'auto';
      const prevMode = this.getCapabilityValue('thermostat_mode');
      if (prevMode !== modeStr) {
        this.setCapabilityValue('thermostat_mode', modeStr).catch(this.error);
      }

      // Register 2: Water temperature T1S (Bit0-7=zone1, Bit8-15=zone2)
      const t1sReg = ModbusClient.bufferToUint16(buffer.subarray(4, 6));
      const targetTemp = t1sReg & 0xFF; // Zone 1 (low byte)
      const prevTargetTemp = this.getCapabilityValue('target_temperature');
      if (prevTargetTemp !== targetTemp) {
        this.setCapabilityValue('target_temperature', targetTemp).catch(this.error);
      }

      // Register 4: T5s DHW target temperature (direct °C, range 20-75)
      if (this.hasCapability('target_temperature.dhw')) {
        const dhwTarget = ModbusClient.bufferToUint16(buffer.subarray(8, 10));
        const prevDhwTarget = this.getCapabilityValue('target_temperature.dhw');
        if (prevDhwTarget !== dhwTarget) {
          this.setCapabilityValue('target_temperature.dhw', dhwTarget).catch(this.error);
        }
      }

      // Register 5: Function setting bitfield
      const funcReg = this._registerCache[5];
      // BIT6 = Silent mode
      const silentMode = (funcReg & 0x0040) !== 0;
      const prevSilentMode = this.getCapabilityValue('silent_mode');
      if (prevSilentMode !== silentMode) {
        this.setCapabilityValue('silent_mode', silentMode).catch(this.error);
      }

    } catch (error) {
      this.log('Error processing control registers:', error);
    }
  }

  // ============================================
  // RUNNING PARAMETERS (FC 0x03) - Registers 100-146
  // Read-only sensor data, status bits, energy
  // ============================================
  async processRunningParameters(slaveId) {
    try {
      // Read 47 registers starting at address 100 (100-146)
      const result = await this.modbus.readHoldingRegisters(slaveId, 100, 47);
      const buffer = Buffer.concat(result);

      // Helper to read a signed 16-bit value at register offset from base 100
      const getInt16 = (reg) => ModbusClient.bufferToInt16(buffer.subarray((reg - 100) * 2, (reg - 100) * 2 + 2));
      const getUint16 = (reg) => ModbusClient.bufferToUint16(buffer.subarray((reg - 100) * 2, (reg - 100) * 2 + 2));

      // Register 100: Compressor operating frequency (Hz)
      const compressorFreq = getUint16(100);
      const compressorOn = compressorFreq > 0;
      const prevCompressor = this.getCapabilityValue('compressor_status');
      if (prevCompressor !== compressorOn) {
        this.setCapabilityValue('compressor_status', compressorOn).catch(this.error);
        if (prevCompressor !== null && prevCompressor !== undefined) {
          if (compressorOn) {
            this.homey.flow.getDeviceTriggerCard('compressor_started')
              .trigger(this, {}, {}).catch(this.error);
          } else {
            this.homey.flow.getDeviceTriggerCard('compressor_stopped')
              .trigger(this, {}, {}).catch(this.error);
          }
        }
      }

      // Register 101: Operating mode (0=off, 2=cooling, 3=heating)
      const oduCycleRaw = getUint16(101);
      const oduCycleStr = this.driver.ODU_CYCLES[oduCycleRaw] || 'standby';
      const prevOduCycle = this.getCapabilityValue('odu_cycle');
      if (prevOduCycle !== oduCycleStr) {
        this.setCapabilityValue('odu_cycle', oduCycleStr).catch(this.error);
        if (prevOduCycle) {
          this.homey.flow.getDeviceTriggerCard('odu_cycle_changed')
            .trigger(this, { cycle: oduCycleStr }, {}).catch(this.error);
        }
      }

      // Register 104: Water inlet temperature (TW_in, direct °C)
      const waterInletTemp = getInt16(104);
      this.setCapabilityValue('measure_temperature.water_inlet', waterInletTemp).catch(this.error);

      // Register 105: Water outlet temperature (TW_out, direct °C)
      const waterOutletTemp = getInt16(105);
      this.setCapabilityValue('measure_temperature.water_outlet', waterOutletTemp).catch(this.error);

      // Register 107: T4 outdoor ambient temperature (direct °C)
      const outdoorTemp = getInt16(107);
      this.setCapabilityValue('measure_temperature.outdoor', outdoorTemp).catch(this.error);

      // Register 110: T1 total water outlet temperature (direct °C) → main measure_temperature
      const t1Temp = getInt16(110);
      this.setCapabilityValue('measure_temperature', t1Temp).catch(this.error);

      // Register 111: T1B system total water outlet (behind auxiliary heater, direct °C)
      if (this.hasCapability('measure_temperature.backup_heater')) {
        const t1bTemp = getInt16(111);
        this.setCapabilityValue('measure_temperature.backup_heater', t1bTemp).catch(this.error);
      }

      // Register 114: Ta room temperature (direct °C)
      const roomTemp = getInt16(114);
      this.setCapabilityValue('measure_temperature.room', roomTemp).catch(this.error);

      // Register 115: T5 water tank temperature (direct °C)
      if (this.hasCapability('measure_temperature.dhw')) {
        const dhwTemp = getInt16(115);
        this.setCapabilityValue('measure_temperature.dhw', dhwTemp).catch(this.error);
      }

      // Register 118: Outdoor unit current (A)
      const current = getUint16(118);

      // Register 119: Outdoor unit voltage (V) — actual value / 10
      const voltageRaw = getUint16(119);
      const voltage = voltageRaw / 10;

      // Calculate instantaneous electrical power (W)
      const electricalPower = Math.round(voltage * current);
      this.setCapabilityValue('measure_power', electricalPower).catch(this.error);

      // Register 124: Current fault code
      const errorCode = getUint16(124);
      const prevErrorCode = this.getCapabilityValue('error_code');
      if (prevErrorCode !== errorCode) {
        this.setCapabilityValue('error_code', errorCode).catch(this.error);
        if (errorCode > 0 && (prevErrorCode === 0 || prevErrorCode === null)) {
          this.homey.flow.getDeviceTriggerCard('error_detected')
            .trigger(this, { error_code: errorCode }, {}).catch(this.error);
          this.setWarning(`Error code: ${errorCode}`);
        }
      }

      // alarm_generic based on error code
      const hasError = errorCode > 0;
      const prevError = this.getCapabilityValue('alarm_generic');
      if (prevError !== hasError) {
        this.setCapabilityValue('alarm_generic', hasError).catch(this.error);
        if (!hasError && prevError) {
          this.homey.flow.getDeviceTriggerCard('error_cleared')
            .trigger(this, {}, {}).catch(this.error);
          this.unsetWarning();
        }
      }

      // Register 128: Status bit 1
      const statusBit1 = getUint16(128);
      // BIT1 = Defrosting
      const defrosting = (statusBit1 & 0x0002) !== 0;
      const prevDefrosting = this.getCapabilityValue('defrosting_status');
      if (prevDefrosting !== defrosting) {
        this.setCapabilityValue('defrosting_status', defrosting).catch(this.error);
        if (prevDefrosting !== null && prevDefrosting !== undefined) {
          if (defrosting) {
            this.homey.flow.getDeviceTriggerCard('defrosting_started')
              .trigger(this, {}, {}).catch(this.error);
          } else {
            this.homey.flow.getDeviceTriggerCard('defrosting_stopped')
              .trigger(this, {}, {}).catch(this.error);
          }
        }
      }

      // Register 129: Load output
      const loadOutput = getUint16(129);
      // BIT3 = Water pump PUMP_I
      const waterPump = (loadOutput & 0x0008) !== 0;
      const prevWaterPump = this.getCapabilityValue('water_pump_status');
      if (prevWaterPump !== waterPump) {
        this.setCapabilityValue('water_pump_status', waterPump).catch(this.error);
      }

      // DHW heating status: derive from load output and DHW state
      // If compressor is running and DHW is enabled and T5 < T5s, it's likely heating DHW
      if (this.hasCapability('dhw_heating_status')) {
        const dhwEnabled = this.getCapabilityValue('dhw_enabled');
        const dhwTemp = this.getCapabilityValue('measure_temperature.dhw');
        const dhwTarget = this.getCapabilityValue('target_temperature.dhw');
        const dhwHeating = dhwEnabled === true && compressorOn && dhwTemp !== null && dhwTarget !== null && dhwTemp < dhwTarget;
        const prevDhwHeating = this.getCapabilityValue('dhw_heating_status');
        if (prevDhwHeating !== dhwHeating) {
          this.setCapabilityValue('dhw_heating_status', dhwHeating).catch(this.error);
          if (prevDhwHeating !== null && prevDhwHeating !== undefined) {
            if (dhwHeating) {
              this.homey.flow.getDeviceTriggerCard('dhw_heating_started')
                .trigger(this, {}, {}).catch(this.error);
            } else {
              this.homey.flow.getDeviceTriggerCard('dhw_heating_stopped')
                .trigger(this, {}, {}).catch(this.error);
            }
          }
        }
      }

      // Register 138: Water flow (actual value * 100, unit m³/H)
      // Convert m³/H to L/min: m³/H * 1000/60 = L/min * 16.667
      const waterFlowRaw = getUint16(138);
      const waterFlowM3H = waterFlowRaw / 100;
      const waterFlowLMin = Math.round(waterFlowM3H * 16.667 * 10) / 10;
      this.setCapabilityValue('measure_water', waterFlowLMin).catch(this.error);

      // Registers 143-144: Electricity consumption (32-bit high+low) → meter_power (kWh)
      const elecHigh = getUint16(143);
      const elecLow = getUint16(144);
      const elecConsumption = elecHigh * 65536 + elecLow;
      // Assume value is in Wh, convert to kWh
      this.setCapabilityValue('meter_power', Math.round(elecConsumption / 10) / 100).catch(this.error);

      // Registers 145-146: Power output (32-bit high+low) → meter_power.heat (kWh)
      const powerOutHigh = getUint16(145);
      const powerOutLow = getUint16(146);
      const powerOutput = powerOutHigh * 65536 + powerOutLow;
      this.setCapabilityValue('meter_power.heat', Math.round(powerOutput / 10) / 100).catch(this.error);

      // Calculate thermal output power from flow rate and delta T
      // Q(W) = flowRate(L/min) / 60 * 1000(g/L) * 4.186(J/g·°C) * deltaT(°C)
      // Simplified: Q(W) = flowRate * 69.77 * deltaT
      let thermalPower = 0;
      if (compressorOn && waterPump && waterOutletTemp !== null && waterInletTemp !== null) {
        const deltaT = Math.abs(waterOutletTemp - waterInletTemp);
        thermalPower = Math.round(waterFlowLMin * 69.77 * deltaT);
      }
      this.setCapabilityValue('measure_power.heat', thermalPower).catch(this.error);

      // Calculate COP = thermal output / electrical input
      if (electricalPower > 0 && thermalPower > 0) {
        const cop = Math.round((thermalPower / electricalPower) * 10) / 10;
        this.setCapabilityValue('measure_cop', Math.min(cop, 15)).catch(this.error);
      } else {
        this.setCapabilityValue('measure_cop', null).catch(this.error);
      }

    } catch (error) {
      this.log('Error processing running parameters:', error);
    }
  }

  // ============================================
  // CAPABILITY LISTENERS (write to Modbus)
  // All writes use FC06 (writeSingleRegister)
  // Bitfield writes use read-modify-write pattern
  // ============================================

  setupCapabilityListeners() {
    // onoff → Register 0, BIT0 (AC zone1) + BIT1 (floor heating zone1)
    this.registerCapabilityListener('onoff', async (value) => {
      await this.writeBitfield(0, 0x03, value ? 0x03 : 0x00);
      this.log(`Heating/Cooling set to: ${value}`);
    });

    // thermostat_mode → Register 1 (1=Auto, 2=Cool, 3=Heat)
    this.registerCapabilityListener('thermostat_mode', async (value) => {
      const modeValue = Object.keys(this.driver.OPERATION_MODES).find(
        key => this.driver.OPERATION_MODES[key] === value
      );
      if (modeValue !== undefined) {
        await this.writeHoldingRegister(1, parseInt(modeValue));
        this.log(`Thermostat mode set to: ${value} (register value: ${modeValue})`);
      }
    });

    // target_temperature → Register 2 (low byte = zone1 T1S)
    this.registerCapabilityListener('target_temperature', async (value) => {
      // Read current register to preserve zone2 (high byte)
      const currentVal = this._registerCache[2] || 0;
      const newVal = (currentVal & 0xFF00) | (Math.round(value) & 0xFF);
      await this.writeHoldingRegister(2, newVal);
      this.log(`Target temperature set to: ${value}°C`);
    });

    // target_temperature.dhw → Register 4 (T5s, direct °C)
    if (this.hasCapability('target_temperature.dhw')) {
      this.registerCapabilityListener('target_temperature.dhw', async (value) => {
        await this.writeHoldingRegister(4, Math.round(value));
        this.log(`DHW target temperature set to: ${value}°C`);
      });
    }

    // DHW enable → Register 0, BIT2
    if (this.hasCapability('dhw_enabled')) {
      this.registerCapabilityListener('dhw_enabled', async (value) => {
        await this.writeBitfield(0, 0x04, value ? 0x04 : 0x00);
        this.log(`DHW set to: ${value}`);
      });
    }

    // Silent mode → Register 5, BIT6
    this.registerCapabilityListener('silent_mode', async (value) => {
      await this.writeBitfield(5, 0x0040, value ? 0x0040 : 0x00);
      this.log(`Silent mode set to: ${value}`);
    });

    this.log('Capability listeners registered');
  }

  // Helper: read-modify-write a bitfield in a holding register
  async writeBitfield(address, mask, value) {
    if (!await this.connectModbus()) {
      throw new Error('Modbus connection failed');
    }
    const slaveId = this.settings.slave_id || 1;

    // Read current value
    const result = await this.modbus.readHoldingRegisters(slaveId, address, 1);
    const currentVal = ModbusClient.bufferToUint16(Buffer.concat(result));

    // Modify bits: clear masked bits, then set new value
    const newVal = (currentVal & ~mask) | (value & mask);

    // Write back
    await this.modbus.writeSingleRegister(slaveId, address, newVal);

    // Update cache
    this._registerCache[address] = newVal;
  }

  // Helper: write a single holding register with connection check
  async writeHoldingRegister(address, value) {
    if (!await this.connectModbus()) {
      throw new Error('Modbus connection failed');
    }
    const slaveId = this.settings.slave_id || 1;
    await this.modbus.writeSingleRegister(slaveId, address, value);
  }

  // ============================================
  // FLOW CARD TRIGGERS
  // ============================================

  registerFlowCardTriggers() {
    // All trigger cards are device trigger cards registered via getDeviceTriggerCard
    // They are triggered inline during polling when values change
    this.log('Flow card triggers registered');
  }

  // ============================================
  // FLOW CARD CONDITIONS
  // ============================================

  async conditionOduCycleIs(args) {
    const cycle = this.getCapabilityValue('odu_cycle');
    return cycle === args.cycle;
  }

  async conditionIsHeating() {
    const cycle = this.getCapabilityValue('odu_cycle');
    return cycle === 'heating';
  }

  async conditionIsCooling() {
    const cycle = this.getCapabilityValue('odu_cycle');
    return cycle === 'cooling';
  }

  async conditionIsDefrosting() {
    const defrosting = this.getCapabilityValue('defrosting_status');
    return defrosting === true;
  }

  async conditionCompressorIsOn() {
    const compressor = this.getCapabilityValue('compressor_status');
    return compressor === true;
  }

  async conditionDhwIsActive() {
    const dhwHeating = this.getCapabilityValue('dhw_heating_status');
    return dhwHeating === true;
  }

  async conditionTemperatureAbove(args) {
    const temperature = this.getCapabilityValue('measure_temperature');
    return temperature > args.temperature;
  }

  // ============================================
  // FLOW CARD ACTIONS
  // ============================================

  async actionSetDhwTargetTemperature(args) {
    try {
      await this.writeHoldingRegister(4, Math.round(args.temperature));
      await this.setCapabilityValue('target_temperature.dhw', args.temperature);
      this.log(`DHW target temperature set to: ${args.temperature}°C`);
      return true;
    } catch (error) {
      this.log('Error setting DHW target temperature:', error);
      throw error;
    }
  }

  async actionEnableDhw() {
    try {
      await this.writeBitfield(0, 0x04, 0x04);
      await this.setCapabilityValue('dhw_enabled', true);
      this.log('DHW enabled');
      return true;
    } catch (error) {
      this.log('Error enabling DHW:', error);
      throw error;
    }
  }

  async actionDisableDhw() {
    try {
      await this.writeBitfield(0, 0x04, 0x00);
      await this.setCapabilityValue('dhw_enabled', false);
      this.log('DHW disabled');
      return true;
    } catch (error) {
      this.log('Error disabling DHW:', error);
      throw error;
    }
  }

  async actionEnableSilentMode() {
    try {
      await this.writeBitfield(5, 0x0040, 0x0040);
      await this.setCapabilityValue('silent_mode', true);
      this.log('Silent mode enabled');
      return true;
    } catch (error) {
      this.log('Error enabling silent mode:', error);
      throw error;
    }
  }

  async actionDisableSilentMode() {
    try {
      await this.writeBitfield(5, 0x0040, 0x00);
      await this.setCapabilityValue('silent_mode', false);
      this.log('Silent mode disabled');
      return true;
    } catch (error) {
      this.log('Error disabling silent mode:', error);
      throw error;
    }
  }

  // ============================================
  // LIFECYCLE
  // ============================================

  async onDeleted() {
    this.log('Kaisai AWHP Device deleted');
    this._isDeleted = true;
    this.stopPolling();
    this.disconnectModbus();
  }
}

module.exports = KaisaiAWHPDevice;
