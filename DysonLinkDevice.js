﻿"use strict";

const mqtt = require('mqtt');
const crypto = require('crypto');
const EventEmitter = require("events").EventEmitter;
const DysonFanState = require("./DysonFanState").DysonFanState;
const DysonEnvironmentState = require("./DysonEnvironmentState").DysonEnvironmentState;
const DysonClimateControl = require('./DysonClimateControl').DysonClimateControl;



class DysonLinkDevice {
    static get SENSOR_EVENT() { return "sensor-updated"; }
    static get STATE_EVENT() { return "state-updated"; }

    constructor(displayName, ip, serialNumber, password, climateControl, log) {
        this.log = log;
        this.serialNumber = serialNumber;
        this.displayName = displayName;
        let serialRegex = /DYSON-(\w{3}-\w{2}-\w{8})-(\w{3})/;
        let [, id, model] = serialNumber.match(serialRegex) || [];
        if (!id || !model) {

            this.log.error("Incorrect serial number");
            this._valid = false;
        }

        else {
            this._id = id;
            this.model = model;
            this._valid = true;
            this._ip = ip;
            this._password = password;
        }

        if (this.valid) {

            this.mqttEvent = new EventEmitter();
            // There can be 11 listeners for this at the same time
            this.mqttEvent.setMaxListeners(15);
            this.environmentEvent = new EventEmitter();
            var mqttClientOptions = {
                username: this._id,
                password: this._password
            }
            if (this.model === '438' || this.model === '520') {
                mqttClientOptions.protocolVersion = 3;
                mqttClientOptions.protocolId = 'MQIsdp';
            }
            this.mqttClient = mqtt.connect("mqtt://" + this._ip, mqttClientOptions);

            this.statusSubscribeTopic = this.model + "/" + this._id + "/status/current";
            this.commandTopic = this.model + "/" + this._id + "/command";

            this.fanState = new DysonFanState(this.heatAvailable, this.Is2018Dyson);
            this.environment = new DysonEnvironmentState();

            if (climateControl) {
                this.climateControl = new DysonClimateControl(climateControl, this, this.displayName, this.log);
            }

            this.mqttClient.on('connect', () => {
                this.log.info("Connected to " + this._id + ". subscribe now");
                this.mqttClient.subscribe(this.statusSubscribeTopic);
                this.requestForCurrentUpdate();
            });

            this.mqttClient.on('message', (topic, message) => {
                this.log.info(message.toString());
                let result = JSON.parse(message);
                switch (result.msg) {
                    case "ENVIRONMENTAL-CURRENT-SENSOR-DATA":
                        this.log.info("Update sensor data from ENVIRONMENTAL-CURRENT-SENSOR-DATA - " + this.displayName);
                        this.environment.updateState(result);
                        this.environmentEvent.emit(this.SENSOR_EVENT);
                        if (this.climateControl) {
                            this.climateControl.environmentUpdate(this.environment);
                        }
                        break;
                    case "CURRENT-STATE":
                        this.log.info("Update fan data from CURRENT-STATE - " + this.displayName);
                        this.fanState.updateState(result);
                        this.mqttEvent.emit(this.STATE_EVENT);
                        break;
                    case "STATE-CHANGE":
                        this.log.info("STATE-CHANGE detected, request update - " + this.displayName);
                        this.requestForCurrentUpdate();
                        break;
                }
            });

            setInterval(() => { // Update the sensors every 10 minutes
                this.log.debug("Fetching new sensors data");
                this.requestForCurrentUpdate();
            }, 600000);
        }
    }

    isClimateControlSupported() {
        return !!this.climateControl;
    }

    isClimateControlEnabled(callback) {
        callback(null, this.climateControl.isEnabled());
    }

    setClimateControl(value, callback) {
        this.log.debug(this.displayName + " - Set Climate control: " + value);
        if (value == 1) {
            this.climateControl.enable();
        } else {
            this.climateControl.disable();
        }
        this.requestForCurrentUpdate();
        this.isClimateControlEnabled(callback);
    }

    requestForCurrentUpdate() {
        // Only do this when we have less than one listener to avoid multiple call
        let senorlisternerCount = this.environmentEvent.listenerCount(this.SENSOR_EVENT);
        let fanlisternerCount = this.mqttEvent.listenerCount(this.STATE_EVENT);
        this.log.debug("Number of listeners - sensor:"+ senorlisternerCount + " fan:" + fanlisternerCount);
        if(senorlisternerCount <=1 && fanlisternerCount <=1) {
            this.log("Request for current state update");
            let currentTime = new Date();
                if(this.mqttClient.connected){
                this.mqttClient.publish(this.commandTopic, JSON.stringify({
                    msg: 'REQUEST-CURRENT-STATE',
                    time: currentTime.toISOString()
                }));
            }
        }
    }

    setState(state) {
        let currentTime = new Date();
        let message = { msg: "STATE-SET", time: currentTime.toISOString(), data: state };
        this.log.info(this.displayName + " - Set State:" + JSON.stringify(state));
        this.mqttClient.publish(this.commandTopic, JSON.stringify(message));
    }

    // The value property of TargetHeaterCoolerState must be one of the following:
    // Characteristic.TargetHeaterCoolerState.AUTO = 0;
    // Characteristic.TargetHeaterCoolerState.HEAT = 1;
    // Characteristic.TargetHeaterCoolerState.COOL = 2;
    setHeaterCoolerState(value, callback) {
        this.log.debug(this.displayName + " - Set target heater cooler state: " + value);
        switch (value) {
            case 0:
                this.setState({ fmod: "AUTO" });
                break;
            case 1:
                this.setState({ hmod: "HEAT" });
                break;
            case 2:
                this.setState({ fmod: "FAN" });
                this.setState({ hmod: "OFF" });
                break;
        }
        this.getHeaterCoolerState(callback);
    }

    getHeaterCoolerState(callback) {
        if(this.mqttClient.connected){
            this.mqttEvent.once(this.STATE_EVENT, () => {
                this.log.info(this.displayName + " - Target Heater Cooler State:" + this.fanState.targetHeaterCoolerState);
                callback(null, this.fanState.targetHeaterCoolerState);
            });
            // Request for update
            this.requestForCurrentUpdate();
        }
        else {
            callback(null, 0);
        }
    }


    setCurrentHeaterCoolerState(value, callback) {
        this.log.debug(this.displayName + " - Set current heater cooler state: " + value);
        this.getCurrentHeaterCoolerState(callback);
    }

    getCurrentHeaterCoolerState(callback) {
        if(this.mqttClient.connected){
            this.mqttEvent.once(this.STATE_EVENT, () => {
                this.log.info(this.displayName + " - Heater Cooler State:" + this.fanState.heaterCoolerState);
                callback(null, this.fanState.heaterCoolerState);
            });
            // Request for update
            this.requestForCurrentUpdate();
        }
        else {
            callback(null, 0);
        }
    }

    setHeaterOn(value, callback) {
        if (this.model === '527') {
            if (value == 1) {
                this.setState({ hmod: "HEAT" });
            } else {
                this.setState({ fmod: "FAN" });
                this.setState({ hmod: "OFF" });
            }
        } else {
            this.setState({ fmod: value == 1 ? "FAN" : "OFF" });
            if(value && this.fanState.heaterCoolerState == 2) {

            }
        }
        this.isFanOn(callback);
    }

    setFanState(value, callback) {
        switch (value) {
            case 0:
                this.setState({ fmod: "OFF" });
                break;
            case 1:
                this.setState({ hmod: "HEAT" });
                break;
            case 2:
                this.setState({ fmod: "FAN" });
                break;
            case 3:
                this.setState({ fmod: "AUTO" });
                break;
        }

    }

    setThresholdTemperture(value, callback) {
        var kelvin = (value + 273) * 10;
        if (this.model === '527') {
            this.setState({hmax: kelvin.toString()});
        } else {
            this.setState({hmax: kelvin});
        }

        this.getThresholdTemperture(callback);

    }
    getThresholdTemperture(callback) {
        if(this.mqttClient.connected){
            this.mqttEvent.once(this.STATE_EVENT, () => {
                this.log.info(this.displayName + " - Heat Threshold:" + this.fanState.heatThreshold);
                callback(null, this.fanState.heatThreshold);
            });
            // Request for update
            this.requestForCurrentUpdate();
        }
        else {
            callback(null, 0);
        }
    }

    getFanState(callback) {
        if(this.mqttClient.connected){
            this.mqttEvent.once(this.STATE_EVENT, () => {
                this.log.info(this.displayName + " - Fan State:" + this.fanState.fanState);
                callback(null, this.fanState.fanState);
            });
            // Request for update
            this.requestForCurrentUpdate();
        }
        else {
            callback(null, 0);
        }
    }

    setFanSpeed(value, callback) {
        this.setState({ fnsp: Math.round(value / 10).toString()});
        this.getFanSpeed(callback);
    }

    getFanSpeed(callback) {
        if(this.mqttClient.connected){
            this.mqttEvent.once(this.STATE_EVENT, () => {
                this.log.info(this.displayName + " - Fan Speed:" + this.fanState.fanSpeed);
                callback(null, this.fanState.fanSpeed);
            });
            // Request for update
            this.requestForCurrentUpdate();
        }
        else {
            callback(null, 0);
        }
    }

    getFilterLife(callback) {
        if(this.mqttClient.connected){
            this.mqttEvent.once(this.STATE_EVENT, () => {
                this.log.info(this.displayName + " - Filter Life(%):" + this.fanState.filterLife);
                callback(null, this.fanState.filterLife);
            });
            // Request for update
            this.requestForCurrentUpdate();
        }
        else {
            callback(null, 0);
        }
    }

    getFilterChange(callback) {
        if(this.mqttClient.connected){
            this.mqttEvent.once(this.STATE_EVENT, () => {
                this.log.info(this.displayName + " - Filter Change Required:" + this.fanState.filterChangeRequired);
                // The value property of FilterChangeIndication must be one of the following:
                // Characteristic.FilterChangeIndication.FILTER_OK = 0;
                // Characteristic.FilterChangeIndication.CHANGE_FILTER = 1;
                callback(null, this.fanState.filterChangeRequired? 1 :0);
            });
            // Request for update
            this.requestForCurrentUpdate();
        }
        else {
            callback(null, 0);
        }
    }

    setNightMode(value, callback) {
        this.setState({ nmod: value ? "ON" : "OFF" });
        this.isNightMode(callback);
    }

    isNightMode(callback) {
        if(this.mqttClient.connected){
            this.mqttEvent.once(this.STATE_EVENT, () => {
                this.log.info(this.displayName + " - Night Mode: " + this.fanState.nightMode);
                callback(null, this.fanState.nightMode);
            });
            // Request for update
            this.requestForCurrentUpdate();
        }
    }

    setFocusedJet(value, callback) {
        if(this.Is2018Dyson){
            this.setState({ fdir: value ? "ON" : "OFF" });
        }else {
            this.setState({ ffoc: value ? "ON" : "OFF" });
        }
        this.isFocusedJet(callback);
    }

    isFocusedJet(callback) {
        if(this.mqttClient.connected){
            this.mqttEvent.once(this.STATE_EVENT, () => {
                this.log.info(this.displayName + " - Focused Jet: " + this.fanState.fanFocused);
                callback(null, this.fanState.fanFocused);
            });
            // Request for update
            this.requestForCurrentUpdate();
        }
        else {
            callback(null, 0);
        }
    }

    sleep(ms){
        return new Promise(resolve => setTimeout(resolve,ms));
    }

    setRotate(value, callback) {
        // If the fan is not on, wait for 500ms before setting that
        if(!this.fanState.isFanOn && !this.fanState.isHeatOn){
            this.log.info(this.displayName + " fan is not on, try to wait for 500ms before setting oson");
            this.sleep(500).then(() => {
                this.setState({ oson: value==1 ? "ON" : "OFF" });
                this.isRotate(callback);
            });
        }
        else {
            this.setState({ oson: value==1 ? "ON" : "OFF" });
            this.isRotate(callback);
        }
    }

    isRotate(callback) {
        if(this.mqttClient.connected){
            this.mqttEvent.once(this.STATE_EVENT, () => {
                this.log.info(this.displayName + " - Fan Rotate: " + this.fanState.fanRotate);
                callback(null, this.fanState.fanRotate? 1:0);
            });
            // Request for update
            this.requestForCurrentUpdate();
        }
        else {
            callback(null, 0);
        }
    }

    setHeatOn(value, callback) {
        this.setState({ hmod: value ? "HEAT" : "OFF" });
        this.isHeatOn(callback);
    }

    isHeatOn(callback) {
        if(this.mqttClient.connected){
            this.mqttEvent.once(this.STATE_EVENT, () => {
                this.log.info(this.displayName + " - Heat On: " + this.fanState.fanHeat);
                callback(null, this.fanState.fanHeat);
            });
            // Request for update
            this.requestForCurrentUpdate();
        }
        else {
            callback(null, 0);
        }
    }

    setFanOn(value, callback) {
        // Do not set the fmod to FAN if the fan is set to AUTO already
        if(!this.fanState.fanAuto || value != 1){

            // Checks if the fan is already in the requested state (HomeKit wants to set the Active characteristic every time the rotation speed changes)
            if (value != 1 || (value == 1 && !this.fanState.fanOn)) {
                if (this.Is2018Dyson) {
                    this.setState({fpwr: value==1 ? "ON" : "OFF"})
                }
                else {
                    this.setState({fmod: value == 1 ? "FAN" : "OFF"});
                }

                // Try to set the fan status according to the value in the home app
                if(value ==1) {
                    if(this.accessory.getFanSpeedValue() >0 && !this.fanState.fanAuto) {
                        this.log.info(this.displayName + " Try to restore the fan speed state from home app to " + this.accessory.getFanSpeedValue());
                        this.setState({ fnsp: Math.round(this.accessory.getFanSpeedValue() / 10).toString() });
                    }
                    if(this.accessory.isSwingModeButtonOn()) {
                        this.log.info(this.displayName + " Try to restore the fan swing state from home app");
                        this.setState({ oson: "ON" });
                    }
                    if(this.accessory.isNightModeSwitchOn()) {
                        this.log.info(this.displayName + " Try to restore the night mode state from home app");
                        this.setState({ nmod: "ON" });
                    }
                }
            }
        }
        this.isFanOn(callback);
    }

    isFanOn(callback) {
        if(this.mqttClient.connected){
            this.mqttEvent.once(this.STATE_EVENT, () => {
                this.log.info(this.displayName + " - Fan On: " + this.fanState.fanOn);
                callback(null, this.fanState.fanOn? 1:0);
            });
            // Request for update
            this.requestForCurrentUpdate();
        }
        else {
            callback(null, 0);
        }
    }

    setCurrentFanState(value, callback) {
        this.log.debug(this.displayName + " Set Current Fan Auto State according to target fan state: " + value);
        //this.setState({ fmod: value==1? "AUTO" : "FAN" });
        this.getCurrentFanState(callback);
    }
    //// The value property of CurrentFanState must be one of the following:
    // Characteristic.CurrentFanState.INACTIVE = 0;
    // Characteristic.CurrentFanState.IDLE = 1;
    // Characteristic.CurrentFanState.BLOWING_AIR = 2;
    getCurrentFanState(callback){
        if(this.mqttClient.connected){
            this.mqttEvent.once(this.STATE_EVENT, () => {
                this.log.info(this.displayName + " - Current Fan State: " + this.fanState.fanOn);
                callback(null, this.fanState.fanOn? 2:0);
            });
            // Request for update
            this.requestForCurrentUpdate();
        }
        else {
            callback(null, 0);
        }
    }

    setFanAuto(value, callback) {
        this.log.debug(this.displayName + " Set Fan Auto State according to target fan state: " + value);
        if (this.Is2018Dyson) {
            // turn on the fan before setting the state as auto
            if(value == 1){
                this.setState({fpwr: "ON"})
            }
            this.setState({auto: value == 1 ? "ON" : "OFF"});
        } else {
            this.setState({fmod: value == 1 ? "AUTO" : "FAN"});
        }
        this.isFanAuto(callback);
    }

    isFanAuto(callback) {
        if(this.mqttClient.connected){
            this.mqttEvent.once(this.STATE_EVENT, () => {
                this.log.info(this.displayName + " - Fan Auto: " + this.fanState.fanAuto);
                var fanValue = this.fanState.fanAuto? 1:0;
                this.log.debug("Return target fan value as " +fanValue);
                callback(null, this.fanState.fanAuto? 1:0);
            });
            // Request for update
            this.requestForCurrentUpdate();
        }
        else {
            callback(null, 0);
        }
    }

    getTemperture(callback) {
        
        this.log.debug(this.displayName + " Get temperture");
        if (this.notUpdatedRecently()) {
            if(this.mqttClient.connected){
                this.environmentEvent.once(this.SENSOR_EVENT, () => {
                    this.log.info(this.displayName + "- temperture new value: " + this.environment.temperature);
                    // Wait until the update and return
                    callback(null, this.environment.temperature);
                });
                // Request for update
                this.requestForCurrentUpdate();
            }
            else {
                callback(null, 0);
            }
        }
        else {
            this.log.info(this.displayName + "- temperture cached value: " + this.environment.temperature);
            callback(null, this.environment.temperature);
        }
    }

    getHumidity(callback) {
        this.log.debug(this.displayName + " Get humidity");
        if (this.notUpdatedRecently()) {
            if(this.mqttClient.connected){
                this.environmentEvent.once(this.SENSOR_EVENT, () => {
                    this.log.info(this.displayName + "- humidity new value: " + this.environment.humidity);
                    // Wait until the update and return
                    callback(null, this.environment.humidity);
                });
                // Request for update
                this.requestForCurrentUpdate();
            }
            else{
                callback(null,0);
            }
        }
        else {
            this.log.info(this.displayName + "- humidity cached value: " + this.environment.humidity);
            callback(null, this.environment.humidity);
        }
    }

    getAirQuality(callback) {
        this.log.debug(this.displayName + " Get air quality");
        if (this.notUpdatedRecently()) {
            if(this.mqttClient.connected){
                this.environmentEvent.once(this.SENSOR_EVENT, () => {
                    this.log.info(this.displayName + " - air quality new value: " + this.environment.airQuality);
                    // Wait until the update and return
                    callback(null, this.environment.airQuality);
                });
                // Request for update
                this.requestForCurrentUpdate();
            }
            else{
                callback(null,0);
            }
        }
        else {
            this.log.info(this.displayName + "- air quality cached value: " + this.environment.airQuality);
            callback(null, this.environment.airQuality);
        }
    }

    getPM2_5Density(callback) {
        this.getAirQuality(function() {
            callback(null, this.environment.pm2_5Density);
        }.bind(this));
    }
    getPM10Density(callback) {
        this.getAirQuality(function() {
            callback(null, this.environment.pm10Density);
        }.bind(this));
    }
    getVOCDensity(callback) {
        this.getAirQuality(function() {
            callback(null, this.environment.vocDensity);
        }.bind(this));
    }
    getNitrogenDioxideDensity(callback) {
        this.getAirQuality(function() {
            callback(null, this.environment.nitrogenDioxideDensity);
        }.bind(this));
    }

    notUpdatedRecently() {
        let currentTime = new Date();
        return !this.environment.lastUpdated || (currentTime.getTime() - this.environment.lastUpdated.getTime()) > (60 * 1000);
    }

    get valid() { return this._valid; }
    // 455 is Dyson Pure Hot + Cool Link, 527 is Dyson Pure Hot + Cool 2018
    get heatAvailable() { return this.model === "455" || this.model === "527"; }

    // TP04 is 438, DP04 is 520, HP04 is 527
    get Is2018Dyson() { return this.model === "438" || this.model === "520" || this.model === "527"; }

    get accessory() { return this._accessory ;}
    set accessory(acce) { this._accessory = acce; }
}

module.exports = { DysonLinkDevice };
