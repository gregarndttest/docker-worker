/**
Handler of individual tasks beings at claim ends with posting task results.
*/
import Debug from 'debug';
import request from 'superagent-promise';
import util from 'util';
import uuid from 'uuid';
import waitForEvent from './wait_for_event';
import features from './features';
import { pullDockerImage, IMAGE_ERROR } from './pull_image_to_stream';
import Wordwrap from 'wordwrap';
import { scopeMatch } from 'taskcluster-base/utils';

import DockerProc from 'dockerode-process';
import { PassThrough } from 'stream';
import States from './states';

let debug = new Debug('runTask');
let wordwrap = new Wordwrap(0, 80, { hard: true });

const PAYLOAD_SCHEMA =
  'http://schemas.taskcluster.net/docker-worker/v1/payload.json#';

// TODO probably a terrible error message, look at making it better later
const CANCEL_ERROR = 'Task was canceled by another entity. This can happen using ' +
                   'a taskcluster client or by cancelling a task within Treeherder.';

/*
@example

taskEnvToDockerEnv({ FOO: true });
// => ['FOO=true']

@private
@param {Object} env key=value pair for environment variables.
@return {Array} the docker array format for variables
*/
function taskEnvToDockerEnv(env) {
  if (!env || typeof env !== 'object') {
    return env;
  }

  return Object.keys(env).reduce(function(map, name) {
    map.push(name + '=' + env[name]);
    return map;
  }, []);
}

/**
Convert the feature flags into a state handler.

@param {Object} task definition.
*/
function buildStateHandlers(task) {
  let handlers = [];
  let featureFlags = task.payload.features || {};

  for (let flag in features) {
    let enabled = (flag in featureFlags) ?
      featureFlags[flag] : features[flag].defaults;

    if (enabled) {
      handlers.push(new (features[flag].module)());
    }
  }

  return new States(handlers);
}

/**
Create a list of cached volumes that will be mounted within the docker container.

@param {object} volume cache
@param {object} volumes to mount in the container
 */
async function buildVolumeBindings(taskVolumeBindings, volumeCache, taskScopes) {
  let neededScopes = [];

  for (let volumeName in taskVolumeBindings) {
    neededScopes.push('docker-worker:cache:' + volumeName);

    if (!scopeMatch(taskScopes, neededScopes)) {
      throw new Error(
        'Insufficient scopes to attach "' + volumeName + '" as a cached ' +
        'volume.  Try adding ' + neededScopes + ' to the .scopes array.'
      );
    }
  }

  let bindings = [];
  let caches = [];

  for (let volumeName in taskVolumeBindings) {
    let cacheInstance = await volumeCache.get(volumeName);
    let binding = cacheInstance.path + ':' + taskVolumeBindings[volumeName];
    bindings.push(binding);
    caches.push(cacheInstance.key);
  }
  return [caches, bindings];
}

export default class Task {
  /**
  @param {Object} runtime global runtime.
  @param {Object} task id for this instance.
  @param {Object} claim details for this instance.
  @param {Object} options
  @param {Number} [options.cpuset] cpu(s) to use for this container/task.
  */
  constructor(runtime, task, claim, options) {
    this.runtime = runtime;
    this.task = task;
    this.claim = claim;
    this.status = claim.status;
    this.runId = claim.runId;
    this.taskState = 'pending';
    this.options = options;

    // Primarly log of all actions for the task.
    this.stream = new PassThrough();

    // states actions.
    this.states = buildStateHandlers(task);
  }

  /**
  Build the docker container configuration for this task.

  @param {Array[dockerode.Container]} [links] list of dockerode containers.
  */
  async dockerConfig(links) {
    let config = this.task.payload;
    let env = config.env || {};

    // Universally useful environment variables describing the current task.
    env.TASK_ID = this.status.taskId;
    env.RUN_ID = this.runId;

    await this.runtime.privateKey.decryptEnvVariables(
        this.task.payload, this.status.taskId
    );

    let procConfig = {
      start: {},
      create: {
        Image: config.image,
        Cmd: config.command,
        Hostname: '',
        User: '',
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        OpenStdin: false,
        StdinOnce: false,
        Env: taskEnvToDockerEnv(env)
      }
    };

    // Zero is a valid option so only check for existence.
    if ('cpuset' in this.options) {
      procConfig.create.Cpuset = this.options.cpuset;
    }

    if (links) {
      procConfig.start.Links = links.map(function(link) {
        return link.name + ':' + link.alias;
      });
    }

    if (this.task.payload.cache) {
      let bindings = await buildVolumeBindings(this.task.payload.cache,
        this.runtime.volumeCache, this.task.scopes);
      this.volumeCaches = bindings[0];
      procConfig.start.Binds = bindings[1];
    }

    return procConfig;
  }

  fmtLog() {
    let args = Array.prototype.slice.call(arguments);
    let str = '[taskcluster] ' + util.format.apply(this, args) + '\r\n';
    // Ensure we generate somewhat nicely aligned 80 width lines.
    return wordwrap(str);
  }

  logHeader() {
    let header = this.fmtLog(
      'taskId: %s, workerId: %s',
      this.status.taskId, this.runtime.workerId
    );

    // List caches if used...
    if (this.task.payload.cache) {
      for (let key in this.task.payload.cache) {
        let path = this.task.payload.cache[key];
        header += this.fmtLog(
          'using cache "%s" -> %s', key, path
        );
      }
    }

    return header + '\r\n';
  }

  logFooter(success, exitCode, start, finish) {
    // Human readable success/failure thing...
    let humanSuccess = success ?
      'Successful' :
      'Unsuccessful';

    // Yes, date subtraction yields a Number.
    let duration = (finish - start) / 1000;

    return this.fmtLog(
      '%s task run with exit code: %d completed in %d seconds',
      humanSuccess, exitCode, duration
    );
  }

  logSchemaErrors(prefix, errors) {
    return this.fmtLog(
      "%s format is invalid json schema errors:\n %s",
      prefix, JSON.stringify(errors, null, 2)
    );
  }

  /**
   * Aborts a run that is currently running or being prepared to run (pulling images,
   * establishing states, etc).  This will optionally write an error to the stream
   * and then write the footer and kill states.
   *
   * @param {String} stat - Name of the current state to be used when generating stats for killing states
   * @param {String} error - Option error to write to the stream prior to aborting
   */
  async abortRun(stat, error='') {
    if (!this.isCanceled()) this.taskState = 'aborted';

    this.runtime.stats.increment('tasks.aborted');

    this.runtime.log('task aborted', {
      taskId: this.status.taskId,
      runId: this.runId,
      exception: this.taskException || '',
      err: error
    });

    if (error) this.stream.write(error);

    // Ensure that the stream has completely finished.
    await this.stream.end(this.logFooter(
      false, // unsuccessful task
      -1, // negative exit code indicates infrastructure errors usually.
      this.taskStart, // duration details...
      new Date()
    ));

    try {
      await this.runtime.stats.timeGen(`tasks.time.states.${stat}.killed`, this.states.killed(this));
    }
    catch (e) {
      // Do not throw, killing the states is a best effort here when aborting
      debug(`Caught error while killing state handlers. ${e}`);
    }


    if (this.isAborted()) {
      let queue = this.runtime.queue;
      let reporter = this.taskException ? queue.reportException : queue.reportFailed;
      let reportDetails = [this.status.taskId, this.runId];
      if (this.taskException) reportDetails.push({ reason: this.taskException });

      await reporter.apply(queue, reportDetails);
    }

    this.runtime.log('task resolved', {
      taskId: this.status.taskId,
      runId: this.runId,
      taskState: this.taskState
    });

    return false;
  }

  /**
   * Resolves a run that has completed and reports to the proper exchange.
   *
   * If a task has been canceled or aborted, abortRun() should be used since the
   * run did not complete.
   *
   * @param {Boolean} success
   */
  async completeRun(success) {
    let queue = this.runtime.queue;
    let reporter = success ? queue.reportCompleted : queue.reportFailed;
    let reportDetails = [this.status.taskId, this.runId];

    await reporter.apply(queue, reportDetails);

    this.runtime.log('task resolved', {
      taskId: this.status.taskId,
      runId: this.runId,
      taskState: success ? 'completed' : 'failed'
    });
  }

  /**
  Determine when the right time is to issue another reclaim then schedule it
  via set timeout.
  */
  scheduleReclaim(claim) {
    // Figure out when to issue the next claim...
    let takenUntil = (new Date(claim.takenUntil) - new Date());
    let nextClaim = takenUntil / this.runtime.task.reclaimDivisor;

    // This is tricky ensure we have logs...
    this.runtime.log('next claim', {
      taskId: this.status.taskId,
      runId: this.runId,
      time: nextClaim
    });

    // Figure out when we need to make the next claim...
    this.clearClaimTimeout();

    this.claimTimeoutId =
      setTimeout(function() {
        async () => {
          await this.reclaimTask();
        }()
      }.bind(this), nextClaim);
  }

  /**
  Clear next reclaim if one is pending...
  */
  clearClaimTimeout() {
    if (this.claimTimeoutId) {
      clearTimeout(this.claimTimeoutId);
      this.claimTimeoutId = null;
    }
  }

  setRuntimeTimeout(maxRuntime) {
    let stats = this.runtime.stats;
    let maxRuntimeMS = maxRuntime*1000;
    let runtimeTimeoutId = setTimeout(function() {
      this.taskState = 'aborted';
      stats.increment('tasks.timed_out');
      stats.gauge('tasks.timed_out.max_run_time', this.task.payload.maxRunTime);
      this.runtime.log('task max runtime timeout', {
        maxRunTime: this.task.payload.maxRunTime,
        taskId: this.status.taskId,
        runId: this.runId
      });
      // we don't wait for the promise to resolve just trigger kill here which
      // will cause run to stop processing the task and give us an error
      // exit code.
      this.dockerProcess.kill();
      this.stream.write(this.fmtLog(
        'Task timeout after %d seconds. Force killing container.',
        this.task.payload.maxRunTime
      ));
    }.bind(this), maxRuntimeMS);
    return runtimeTimeoutId;
  }

  /**
  Reclaim the current task and schedule the next reclaim...
  */
  async reclaimTask() {
    this.runtime.log('issue reclaim');
    this.runtime.stats.increment('tasks.reclaims');
    this.claim = await this.runtime.stats.timeGen(
      'tasks.time.reclaim',
      this.runtime.queue.reclaimTask(this.status.taskId, this.runId)
    );

    this.runtime.log('issued reclaim', { claim: this.claim });
    await this.scheduleReclaim(this.claim);
  }

  async start() {
    this.runtime.log('task start', {
      taskId: this.status.taskId,
      runId: this.runId,
      takenUntil: this.claim.takenUntil
    });

    // Task has already been claimed, schedule reclaiming
    await this.scheduleReclaim(this.claim);


    let success;
    try {
      success = await this.run();
    } catch (e) {
      // TODO: Reconsider if we should mark the task as failed or something else
      //       at this point... I intentionally did not mark the task completed
      //       here as to allow for a retry by another worker, etc...
      this.clearClaimTimeout();
      // If task ends prematurely, make sure the container and volume caches get
      // flagged to be cleaned up.
      if (this.dockerProcess && this.dockerProcess.container) {
        this.runtime.gc.removeContainer(this.dockerProcess.container.id, this.volumeCaches);
      }
      throw e;
    }
    // Called again outside so we don't run this twice in the same try/catch
    // segment potentially causing a loop...
    this.clearClaimTimeout();

    if (this.dockerProcess && this.dockerProcess.container) {
      this.runtime.gc.removeContainer(this.dockerProcess.container.id, this.volumeCaches);
    }

    // Mark the task appropriately now that all internal state is cleaned up.
    if (!this.isCanceled() && !this.isAborted()) await this.completeRun(success);
  }

  isAborted() {
    return this.taskState === 'aborted';
  }

  isCanceled() {
    return this.taskState === 'canceled';
  }

  /**
   * Aborts the running of the task.  This is similar to cancelling a task, but
   * will allow time to upload artifacts and report the run as an exception instead.
   *
   * @param {String} reason - Reason for aborting the test run (Example: worker-shutdown)
   */
  abort(reason) {
    this.taskState = 'aborted';
    this.taskException = reason;
    if (this.dockerProcess) this.dockerProcess.kill();

    this.stream.write(
      this.fmtLog(`Task has been aborted prematurely. Reason: ${reason}`)
    );
  }

  /**
   * Cancel the running of the task.  Task cancellation was performed by an external
   * entity and has already been published to task-exception exchange.  This will
   * kill the docker container that might be running, attempt to release resources
   * that were linked, as well as prevent artifacts from uploading, which cannot
   * be done after a run is resolved.
   *
   * @param {String} reason - Reason for cancellation
   */
  cancel(reason) {
    this.taskState = 'canceled';
    this.taskException = reason;

    this.runtime.stats.increment('tasks.canceled');
    this.runtime.log('cancel task', {
      taskId: this.status.taskId, runId: this.runId
    });

    if (this.dockerProcess) this.dockerProcess.kill();

    this.stream.write(this.fmtLog(CANCEL_ERROR));
  }

  /**
  Primary handler for all docker related task activities this handles the
  launching/configuration of all tasks as well as the features for the given
  tasks.

  @return {Boolean} success true/false for complete run.
  */
  async run() {
    this.taskState = 'running';
    this.taskStart = new Date();
    let stats = this.runtime.stats;
    let queue = this.runtime.queue;
    let gc = this.runtime.gc;

    // Cork all writes to the stream until we are done setting up logs.
    this.stream.cork();

    // Task log header.
    this.stream.write(this.logHeader());
    let links;
    try {
      // Build the list of container links...
      links =
        await stats.timeGen('tasks.time.states.linked', this.states.link(this));
      // Hooks prior to running the task.
      await stats.timeGen('tasks.time.states.created', this.states.created(this));
    }
    catch (e) {
      return await this.abortRun(
        'states_failed',
        this.fmtLog(
          'Task was aborted because states could not be created ' +
          `successfully. Error: ${e}`
        )
      );
    }


    // Everything should have attached to the stream by now...
    this.stream.uncork();

    if (this.isCanceled() || this.isAborted()) {
      return await this.abortRun(this.taskState);
    }
    // Validate the schema!
    let payloadErrors =
      this.runtime.schema.validate(this.task.payload, PAYLOAD_SCHEMA);

    if (payloadErrors.length) {
      // Inform the user that this task has failed due to some configuration
      // error on their part.
      this.taskException = 'malformed-payload';
      return await this.abortRun(
        'validation_failed',
        this.logSchemaErrors('`task.payload`', payloadErrors)
      );
    }

    // Download the docker image needed for this task... This may fail in
    // unexpected ways and should be handled gracefully to indicate to the user
    // that their task has failed due to a image specific problem rather then
    // some general bug in taskcluster or the worker code.
    if (this.isCanceled() || this.isAborted()) {
      return await this.abortRun(this.taskState);
    }
    try {
      await pullDockerImage(
        this.runtime,
        this.task.payload.image,
        this.task.scopes,
        this.taskId,
        this.runId,
        this.stream
      );
    } catch (e) {
      return await this.abortRun(
        'pull_failed',
        this.fmtLog(IMAGE_ERROR, this.task.payload.image, e)
      );
    }

    gc.markImage(this.task.payload.image);

    if (this.isCanceled() || this.isAborted()) {
      return await this.abortRun(this.taskState);
    }

    let dockerConfig;
    try {
      dockerConfig = await this.dockerConfig(links);
    } catch (e) {
      let error = this.fmtLog('Docker configuration could not be ' +
        'created.  This may indicate an authentication error when validating ' +
        'scopes necessary for using caches. \n Error %s', e);
      return await this.abortRun('docker_configuration', error);
    }

    if (this.isCanceled() || this.isAborted()) {
      return await this.abortRun(this.taskState);
    }
    let dockerProc = this.dockerProcess = new DockerProc(
      this.runtime.docker, dockerConfig);
    // Now that we know the stream is ready pipe data into it...
    dockerProc.stdout.pipe(this.stream, {
      end: false
    });

    let runtimeTimeoutId = this.setRuntimeTimeout(this.task.payload.maxRunTime);

    if (this.isCanceled() || this.isAborted()) {
      return await this.abortRun(this.taskState);
    }
    this.runtime.log('task run');
    let exitCode = await stats.timeGen('tasks.time.run', dockerProc.run({
      // Do not pull the image as part of the docker run we handle it +
      // authentication above...
      pull: false
    }));

    let success = exitCode === 0;

    clearTimeout(runtimeTimeoutId);

    // XXX: Semi-hack to ensure all consumers of the docker proc stdout get the
    // entire contents. Ideally we could just wait for the end cb but that does
    // not seem to help in this case...
    if (!dockerProc.stdout._readableState.endEmitted) {
      // We wait _before_ extractResult so those states hooks can add items
      // to the stream.
      await waitForEvent(dockerProc.stdout, 'end');
    }

    if (this.isCanceled() || this.isAborted()) {
      return await this.abortRun(this.taskState);
    }

    // Extract any results from the hooks.
    try {
      await stats.timeGen(
        'tasks.time.states.stopped', this.states.stopped(this)
      );
    }
    catch (e) {
      let lookupId = uuid.v4();
      this.runtime.log('task exception', {
        taskId: this.status.taskId,
        runId: this.runId,
        uuid: lookupId,
        err: e.toString(),
        stack: e.stack
      });
      this.stream.write(this.fmtLog(
        `Unknown taskcluster error encountered.  Ask administrator to lookup ` +
        `incidentId in log-file. Incident ID: ${lookupId}`
      ));
      success = false;
      exitCode = -1;
    }

    this.stream.write(this.logFooter(success, exitCode, this.taskStart, new Date()));

    // Wait for the stream to end entirely before killing remaining containers.
    await this.stream.end();

    await stats.timeGen('tasks.time.states.killed', this.states.killed(this));

    // If the results validation failed we consider this task failure.
    if (this.isCanceled() || this.isAborted()) {
      return await this.abortRun(this.taskState);
    }
    return success;
  }
};
