import testworker from '../post_task';
import DockerWorker from '../dockerworker';
import TestWorker from '../testworker';

let worker;

suite('worker timeouts', () => {
  setup(async () => {
    worker = new TestWorker(DockerWorker);
    await worker.launch();
  });

  teardown(async () => {
    await worker.terminate();
  });

  test('worker sleep more than maxRunTime', async () => {
    let maxRunTime = 10;
    let result = await worker.postToQueue({
      payload: {
        image:          'taskcluster/test-ubuntu',
        command:        [
          '/bin/bash', '-c', 'echo "Hello"; sleep 20; echo "done";'
        ],
        maxRunTime: maxRunTime
      }
    });
 
    // Get task specific results
    assert.equal(result.run.state, 'failed', 'task should have failed');
    assert.equal(result.run.reasonResolved, 'failed', 'task should have failed');
    assert.ok(result.log.includes('Hello'));
    assert.ok(!result.log.includes('done'));
    assert.ok(
      result.log.includes(`Reason: Task timeout after ${maxRunTime}`),
      'Task should contain logs about timeout'
    );
  });

  test('run time exceeded before container starts', async () => {
    // Theoretically 1 second should not be enough time between claiming the task
    // and running it in a container.  This test might need to be modified or
    // removed if proven to be unreliable.
    let maxRunTime = 1;
    let result = await worker.postToQueue({
      payload: {
        image:          'taskcluster/test-ubuntu',
        command:        [
          '/bin/bash', '-c', 'echo "Hello"; sleep 20; echo "done";'
        ],
        maxRunTime: maxRunTime,
        features: {
          taskclusterProxy: true
        }
      }
    });

    // Get task specific results
    assert.equal(result.run.state, 'failed', 'task should have failed');
    assert.equal(result.run.reasonResolved, 'failed', 'task should have failed');
    let log = result.log;
    assert.equal(JSON.parse(log).message, 'Artifact not found', 'Task was not aborted before states created');
  });

  test('task claimed after previous task timed out', async () => {
    let maxRunTimeResult = await worker.postToQueue({
      payload: {
        image:          'taskcluster/test-ubuntu',
        command:        [
          '/bin/bash', '-c', 'echo "Hello"; sleep 20; echo "done";'
        ],
        maxRunTime: 10
      }
    });

    // Let's make sure the task ran out of time first before moving on
    assert.equal(maxRunTimeResult.run.state, 'failed', 'task should have failed');
    console.log(maxRunTimeResult.log);
    assert.ok(
      maxRunTimeResult.log.includes(`Reason: Task timeout after 10`),
      'Task should contain logs about timeout'
    );

    let successfulResult = await worker.postToQueue({
      payload: {
        image:          'taskcluster/test-ubuntu',
        command:        [
          '/bin/bash', '-c', 'echo "Hello"'
        ],
        maxRunTime: 60
      }
    });

    assert.equal(
      successfulResult.run.state,
      'completed',
      'Task was not completed successfully'
    );

    assert.equal(
      maxRunTimeResult.run.workerId,
      successfulResult.run.workerId,
      'Tasks were not completed by the same workers'
    );
  });
});
