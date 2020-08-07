//TODO move the group configs into a json/yml/js file, outside of src

import config from './config';

export interface ScalingOptions {
    autoscalerInterval: number;
    jibriMinDesired: number;
    jibriMaxDesired: number;
    jibriScaleUpQuantity: number;
    jibriScaleDownQuantity: number;
    jibriScaleUpThreshold: number;
    jibriScaleDownThreshold: number;
    jibriScalePeriod: number;
    jibriScaleUpPeriodsCount: number;
    jibriScaleDownPeriodsCount: number;
}

export interface InstanceGroup {
    name: string;
    region: string;
    compartment: string;
    compartmentId: string;
    instanceConfigurationId: string;
    scalingOptions: ScalingOptions;
    cloud: string;
}

const lonelyPhoenixScalingOptions: ScalingOptions = {
    autoscalerInterval: 10,
    jibriMinDesired: 1,
    jibriMaxDesired: 2,
    jibriScaleUpQuantity: 1,
    jibriScaleDownQuantity: 1,
    jibriScaleUpThreshold: 1,
    jibriScaleDownThreshold: 2,
    jibriScalePeriod: 60,
    jibriScaleUpPeriodsCount: 2,
    jibriScaleDownPeriodsCount: 4,
};

const groupList: Array<InstanceGroup> = [
    {
        name: 'lonely-us-phoenix-1-JibriGroup1',
        region: 'us-phoenix-1',
        compartment: 'lonely',
        compartmentId: config.DefaultCompartmentId,
        instanceConfigurationId: config.DefaultInstanceConfigurationId,
        scalingOptions: lonelyPhoenixScalingOptions,
        cloud: 'oracle',
    },
    {
        name: 'lonely-us-phoenix-1-JibriGroup2',
        region: 'us-phoenix-1',
        compartment: 'lonely',
        compartmentId: config.DefaultCompartmentId,
        instanceConfigurationId: config.DefaultInstanceConfigurationId,
        scalingOptions: lonelyPhoenixScalingOptions,
        cloud: 'oracle',
    },
];

export default {
    GroupList: groupList,
};
