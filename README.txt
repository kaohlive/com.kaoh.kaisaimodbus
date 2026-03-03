Monitor and control your Kaisai Air-to-Water Heat Pump directly from Homey — no cloud, no delays. This app communicates locally over Modbus TCP through an RS485-to-TCP gateway, giving you fast, reliable access to your heat pump's data and controls.

What you can do:

- Switch heating/cooling on or off and set operation mode (Heat, Cool, Auto)
- Adjust water target temperature and DHW (hot water) target temperature
- Monitor live temperatures: water outlet, water inlet, outdoor, room, DHW tank, and backup heater
- Track energy usage: electrical power consumption, thermal output, and real-time COP
- Monitor water flow rate
- View system status: compressor, water pump, defrost cycle, and outdoor unit activity
- Control DHW heating and silent mode
- Get notified on errors with automatic alarm detection and error codes
- Build automations with flow triggers, conditions, and actions for all key parameters

Requirements:

- Kaisai Air-to-Water Heat Pump (AWHP) with Modbus RTU support
- RS485-to-TCP serial gateway (like Elfin EW-11 or compatible) connected to the heat pump's H1/H2 Modbus port
- Homey Pro with local network access to the gateway

Support & feedback:

- GitHub: https://github.com/kaohlive/com.kaoh.kaisaimodbus
