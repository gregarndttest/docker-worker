suite('test host', function() {
  var co = require('co');
  var subject = require('../lib/host/test');
  var settings = require('./settings');

  setup(settings.cleanup);
  teardown(settings.cleanup);

  test('billingCycleInterval', co(function* () {
    settings.billingCycleInterval(2000);
    assert.equal(2000, subject.billingCycleInterval());
  }));

  test('configure', co(function* () {
    settings.configure({ capacity: 2 });
    assert.deepEqual({ capacity: 2 }, (yield subject.configure()));
  }));
});
