
// See "Characteristic.AirQuality" from https://github.com/KhaosT/HAP-NodeJS/blob/master/lib/gen/HomeKitTypes.js
function convertAirQualityTrigger(qualityArray) {
    return qualityArray.map((el) => {
        switch (el) {
            case 'EXCELLENT':
                return 1;

            case 'GOOD':
                return 2;

            case 'FAIR':
                return 3;

            case 'INFERIOR':
                return 4;

            case 'POOR':
                return 5;

            default:
                return 0;
        }
    })
}

class DysonClimateControl {
 
    constructor(config, dysonLinkDevice, displayName, log) {
        this.log = log;
        this.displayName = displayName;
        this.config = config;
        this.enabled = config.enabled;
        this.device = dysonLinkDevice;
        this.actionApplied = null;
    }

    enable() {
        this.enabled = true;
        this.actionApplied = null;
    }

    isEnabled() {
        return this.enabled;
    }

    disable() {
        this.enabled = false;
        this.actionApplied = null;
    }

    environmentUpdate(dysonEnvironmentState) {
        this.log.debug(`${this.displayName} - Env update received`);

        // Check if enabled
        if (!this.isEnabled()) {
            this.log.debug(`${this.displayName} - Env update - Climate control is disabled; skipping this update`);
            return;
        }

        // Get data
        const { airQuality, humidity, temperature } = dysonEnvironmentState;
        const { rules } = this.config;

        // Evaluate rules
        let actionToApply = null;
        this.log.debug(`${this.displayName} - Env update - Finding which rule to apply (Air quality: ${airQuality} - Temperature: ${temperature} - Humidity: ${humidity}`);

        for (const rule of rules) {
            switch (rule.type) {
                case 'temperature':
                    const [lowTemp, highTemp] = rule.trigger;
                    if (lowTemp <= temperature && temperature <= highTemp) {
                        actionToApply = rule.action;
                    }
                    break;

                case 'humidity':
                    const [lowHum, highHum] = rule.trigger;
                    if (lowHum <= humidity && humidity <= highHum) {
                        actionToApply = rule.action;
                    }
                    break;

                case 'air_quality':
                    const homekitAirQuality = convertAirQualityTrigger(rule.trigger);
                    if (homekitAirQuality.includes(airQuality)) {
                        actionToApply = rule.action;
                    }
                    break;
            }

            if (actionToApply) {
                this.log.debug(`${this.displayName} - Env update - Selected rule: ${rule.name}`);
                break;
            }
        }

        if (actionToApply === null) {
            this.log.debug(`${this.displayName} - Env update - No rule matched`);
        }


        // Do not re-apply the same rule
        if (this.actionApplied == actionToApply) {
            this.log.debug(`${this.displayName} - Env update - Not applying rule, already applied`);
            return;
        }


        // If rule has been matched, apply; turn the fan off otherwise
        const callback = () => true;

        if (actionToApply) {
            this.log.debug(`${this.displayName} - Env update - Applying rule`);
            this.actionApplied = actionToApply;

            if ('fanOn' in actionToApply) {
                this.device.setFanOn(actionToApply.fanOn ? 1 : 0, callback);
            }
            if ('fanAuto' in actionToApply) {
                this.device.setFanAuto(actionToApply.fanAuto ? 1 : 0, callback);
            }
            if ('fanSpeed' in actionToApply) {
                this.device.setFanSpeed(actionToApply.fanSpeed * 10, callback);
            }
            if ('rotate' in actionToApply) {
                this.device.setRotate(actionToApply.rotate ? 1 : 0, callback);
            }
            if ('focusedJet' in actionToApply) {
                this.device.setFocusedJet(actionToApply.focusedJet ? 1 : 0, callback);
            }
            if ('nightMode' in actionToApply) {
                this.device.setNightMode(actionToApply.nightMode ? 1 : 0, callback);
            }
        } else {
            this.log.debug(`${this.displayName} - Env update - Applying rule, turning off the device`);
            this.actionApplied = null;
            this.device.setFanOn(0, callback);
        }
    }
}
 
module.exports = { DysonClimateControl };
