import { exec } from 'child_process';
import { InstanceGroup } from './instance_group';
import { Context } from './context';

function makeRandomString(length: number) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

export interface CustomInstanceManagerOptions {
    isDryRun: boolean;
}

export default class CustomInstanceManager {
    private isDryRun: boolean;

    constructor(options: CustomInstanceManagerOptions) {
        this.isDryRun = options.isDryRun;

        this.launchInstances = this.launchInstances.bind(this);
    }

    async launchInstances(
        ctx: Context,
        group: InstanceGroup,
        groupCurrentCount: number,
        quantity: number,
    ): Promise<Array<string | boolean>> {
        ctx.logger.info(`[custom] Launching a batch of ${quantity} instances in group ${group.name}`);

        const indexes: Array<number> = [];
        for (let i = 0; i < quantity; i++) {
            indexes.push(i);
        }

        const result = await Promise.all(
            indexes.map(async (index) => {
                return this.launchInstance(ctx, index, group);
            }),
        );
        ctx.logger.info(`Finished launching all the instances in group ${group.name}`);

        return result;
    }

    async launchInstance(ctx: Context, index: number, group: InstanceGroup): Promise<string | boolean> {
        const groupName = group.name;
        const groupInstanceConfigurationId = group.instanceConfigurationId;

        const displayName = groupName + '-' + makeRandomString(5);

        ctx.logger.info(`[custom] Launching instance number ${index + 1} in group ${groupName} with properties`, {
            groupName,
            displayName,
            groupInstanceConfigurationId,
        });

        if (this.isDryRun) {
            ctx.logger.info(`[custom] Dry run enabled, skipping the instance number ${index + 1} launch`);
            return true;
        }
        try {
            const launchResponse = await this.execLaunch({
                displayName,
                groupName,
                region: group.region,
                type: group.type,
            });
            ctx.logger.info(
                `[custom] Got launch response for instance number ${
                    index + 1
                } in group ${groupName}: ${launchResponse}`,
            );

            return launchResponse;
        } catch (err) {
            ctx.logger.error(
                `[custom] Failed launching instance number ${index + 1} in group ${groupName} with err ${err}`,
                { err },
            );
            return false;
        }
    }

    async getInstances(): Promise<[]> {
        return [];
    }

    execLaunch({
        displayName,
        groupName,
        region,
        type,
    }: {
        displayName: string;
        groupName: string;
        region: string;
        type: string;
    }): Promise<string> {
        return new Promise(function (resolve, reject) {
            exec(
                `./scripts/custom-launch.sh --type ${type} --name ${displayName} --groupName ${groupName} --region ${region} `,
                (error, stdout) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    resolve(stdout.trim().split('\n').pop());
                },
            );
        });
    }
}
