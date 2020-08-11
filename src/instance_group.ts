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
    compartmentId: string;
    instanceConfigurationId: string;
    scalingOptions: ScalingOptions;
    cloud: string;
}
