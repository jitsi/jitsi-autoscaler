import { NomadClient, NomadJob } from './nomad';
import { InstanceGroup } from './instance_group';
import { Context } from './context';
import { AbstractCloudInstanceManager, CloudInstance } from './cloud_instance_manager';
import { CloudRetryStrategy } from './cloud_manager';

export interface NomadInstanceManagerOptions {
    isDryRun: boolean;
}

export default class NomadInstanceManager extends AbstractCloudInstanceManager {
    private isDryRun: boolean;
    private nomadClient: NomadClient;

    constructor(options: NomadInstanceManagerOptions) {
        super();
        this.isDryRun = options.isDryRun;
        this.nomadClient = new NomadClient();
    }

    private nomadJobFromGroup(group: InstanceGroup) {
        // nomad instance configuration looks like nomadURL|jobName
        return group.instanceConfigurationId.split('|')[1];
    }

    private nomadAddressFromGroup(group: InstanceGroup) {
        // nomad instance configuration looks like nomadURL|jobName
        return group.instanceConfigurationId.split('|')[0];
    }

    async launchInstance(ctx: Context, index: number, group: InstanceGroup): Promise<string | boolean> {
        const groupName = group.name;
        const jobName = this.nomadJobFromGroup(group);

        const randomName = AbstractCloudInstanceManager.makeRandomString(5);
        const displayName = groupName + '-' + randomName;

        const address = this.nomadAddressFromGroup(group);

        ctx.logger.info(`[custom] Launching instance number ${index + 1} in group ${groupName} with properties`, {
            groupName,
            displayName,
            jobName,
        });

        if (this.isDryRun) {
            ctx.logger.info(`[custom] Dry run enabled, skipping the instance number ${index + 1} launch`);
            return true;
        }
        try {
            const meta = { group: group.name, name: randomName };
            const payload = { group: group.name, name: randomName };

            const results = await this.nomadClient.dispatchJob(ctx, address, jobName, payload, meta);

            ctx.logger.info(
                `[custom] Got launch response for instance number ${index + 1} in group ${groupName}: ${
                    results.DispatchedJobID
                }`,
            );

            return `${results.DispatchedJobID}`;
        } catch (err) {
            ctx.logger.error(
                `[custom] Failed launching instance number ${index + 1} in group ${groupName} with err ${err}`,
                { err },
            );
            return false;
        }
    }

    async getInstances(
        ctx: Context,
        group: InstanceGroup,
        _cloudRetryStrategy: CloudRetryStrategy,
    ): Promise<CloudInstance[]> {
        ctx.logger.debug('running list jobs in nomad client');
        const jobs = await this.nomadClient.listJobs(
            ctx,
            this.nomadAddressFromGroup(group),
            this.nomadJobFromGroup(group) + '/',
        );

        return jobs.map((job: NomadJob) => ({
            instanceId: `${job.ID}`,
            displayName: job.Name,
            cloudStatus: this.mapNomadStatusCloudStatus(job.Status),
        }));
    }

    private mapNomadStatusCloudStatus(status: string): string {
        switch (status) {
            case 'pending':
                return 'PROVISIONING';
            case 'running':
                return 'RUNNING';
            case 'stopped':
                return 'SHUTDOWN';
            case 'dead':
                return 'SHUTDOWN';
        }
        return 'Unknown';
    }
}
