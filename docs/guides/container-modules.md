# Container Modules

Garden includes a `container` module type, which provides a high-level abstraction around container-based services, that's easy to understand and use.

`container` modules can be used to just _build_ container images, or they can specify deployable services through the optional `services` key, as well as `tasks` and `tests`. So you might in one scenario use a `container` module to both build and deploy services, and in another you might only build the image using a `container` module, and then refer to that image in a `helm` or `kubernetes` module.

Below we'll walk through some usage examples. For a full reference of the `container` module type, please take a look at the [reference](../reference/module-types/container.md).

_Note: Even though we've spent the most time on supporting Kubernetes, we've tried to design this module type in a way that makes it generically applicable to other container orchestrators as well, such as Docker Swarm, Docker Compose, AWS ECS etc. This will come in handy as we add more providers, that can then use the same module type._

## Building images

A bare minimum `container` module just specifies common required fields:

```yaml
# garden.yml
kind: Module
type: container
name: my-container
```

If you have a `Dockerfile` next to this file, this is enough to tell Garden to build it. You can also specify `dockerfile: <path-to-Dockerfile>` if you need to override the Dockerfile name. You might also want to explicitly [include or exclude](../using-garden/configuration-overview.md#includingexcluding-files-and-directories) files in the build context.

### Build arguments

You can specify [build arguments](https://docs.docker.com/engine/reference/commandline/build/#set-build-time-variables---build-arg) using the [`buildArgs`](../reference/module-types/container.md#buildArgs) field. This can be quite handy, especially when e.g. referencing other modules such as build dependencies:

```yaml
# garden.yml
kind: Module
type: container
name: my-container
build:
  dependencies: [base-image]
buildArgs:
  baseImageVersion: ${modules.base-image.version}
```

Garden will also automatically set `GARDEN_MODULE_VERSION` as a build argument, so that you can reference the version of module being built.

## Using remote images

If you're not building the container image yourself and just need to deploy an external image, you can skip the Dockerfile and specify the `image` field:

```yaml
# garden.yml
kind: Module
type: container
name: redis
image: redis:5.0.5-alpine   # <- replace with any docker image ID
services:
  ...
```

{% hint style="warning" %}
Note that if there is a _Dockerfile_ in the same directory as the module configuration, and you still don't want to build it, you have to tell Garden not to pick it up by setting `include: []` in your module configuration.
{% endhint %}

## Publishing images

You can publish images that have been built in your cluster using the `garden publish` command.

Unless you're publishing to your configured deployment registry (when using the `kubernetes` provider), you need to specify the `image` field on the `container` module in question to indicate where the image should be published. For example:

```yaml
kind: Module
name: my-module
image: my-repo/my-image:v1.2.3   # <- if you omit the tag here, the Garden module version will be used by default
...
```

By default, we use the tag specified in the `container` module `image` field, if any. If none is set there, we default to the Garden module version.

You can also set the `--tag` option on the `garden publish` command to override the tag used for images. You can both set a specific tag or you can _use template strings for the tag_. For example, you can

- Set a specific tag on all published modules: `garden publish --tag "v1.2.3"`
- Set a custom prefix on tags but include the Garden version hash: `garden publish --tag 'v0.1-${module.hash}'`
- Set a custom prefix on tags with the current git branch: `garden publish --tag 'v0.1-${git.branch}'`

{% hint style="warning" %}
Note that you most likely need to wrap templated tags with single quotes, to prevent your shell from attempting to perform its own substitution.
{% endhint %}

Generally, you can use any template strings available for module configs for the tags, with the addition of the following:

- `${module.name}` — the name of the module being tagged
- `${module.version}` — the full Garden version of the module being tagged, e.g. `v-abcdef1234`
- `${module.hash}` — the Garden version hash of the module being tagged, e.g. `abcdef1234` (i.e. without the `v-` prefix)

## Deploying services

`container` modules also have an optional `services` field, which you can use to deploy the container image using your configured providers (such as `kubernetes`/`local-kubernetes`).

In the case of Kubernetes, Garden will take the simplified `container` service specification and convert it to the corresponding Kubernetes manifests, i.e. Deployment, Service and (if applicable) Ingress resources.

Here, for example, is the spec for the `frontend` service in our example [demo project](https://github.com/garden-io/garden/tree/0.12.45/examples/demo-project):

```yaml
kind: Module
name: frontend
description: Frontend service container
type: container
services:
  - name: frontend
    ports:
      - name: http
        containerPort: 8080
    healthCheck:
      httpGet:
        path: /hello-frontend
        port: http
    ingresses:
      - path: /hello-frontend
        port: http
      - path: /call-backend
        port: http
    dependencies:
      - backend
...
```

This, first of all, tells Garden that it should deploy the built `frontend` container as a service with the same name. We also configure a health check, a couple of ingress endpoints, and specify that this service depends on the `backend` service. There is a number of other options, which you can find in the `container` module [reference](../reference/module-types/container.md#services).

If you need to use advanced (or otherwise very specific) features of the underlying platform, you may need to use more platform-specific module types (e.g. `kubernetes` or `helm`). The `container` module type is not intended to capture all those features.

### Environment variables

Container services can specify environment variables, using the `services[].env` field:

```yaml
kind: Module
type: container
name: my-container
services:
  - name: my-container-service
    ...
    env:
      MY_ENV_VAR: foo
      MY_TEMPLATED_ENV_VAR: ${var.some-project-variable}
    ...
...
```

`env` is a simple mapping of "name: value". Above, we see a simple example with a string value, but you'll also commonly use [template strings](../using-garden/variables-and-templating.md#template-string-basics) to interpolate variables to be consumed by the container service.

#### Secrets

As of Garden v0.10.1 you can reference secrets in environment variables. For Kubernetes, this translates to `valueFrom.secretKeyRef` fields in the Pod specs, which direct Kubernetes to mount values from `Secret` resources that you have created in the application namespace, as environment variables in the Pod.

For example:

```yaml
kind: Module
type: container
name: my-container
services:
  - name: my-container-service
    ...
    env:
      MY_SECRET_VAR:
        secretRef:
          name: my-secret
          key: some-key-in-secret
    ...
...
```

This will pull the `some-key-in-secret` key from the `my-secret` Secret resource in the application namespace, and make it available as an environment variable.

_Note that you must create the Secret manually for the Pod to be able to reference it._

For Kubernetes, this is commonly done using `kubectl`. For example, to create a basic generic secret you could use:

```sh
kubectl --namespace <my-app-namespace> create secret generic --from-literal=some-key-in-secret=foo
```

Where `<my-app-namespace>` is your project namespace (which is either set with `namespace` in your provider config, or defaults to your project name). There are notably other, more secure ways to create secrets via `kubectl`. Please refer to the official [Kubernetes Secrets docs](https://kubernetes.io/docs/concepts/configuration/secret/#creating-a-secret-using-kubectl-create-secret) for details.

Also check out the [Kubernetes Secrets example project](https://github.com/garden-io/garden/tree/0.12.45/examples/kubernetes-secrets) for a working example.

## Running tests

You can define both tests and tasks as part of any container module. The two are configured in very similar ways, using the `tests` and `tasks` keys, respectively. Here, for example, is a configuration for two different test suites:

```yaml
kind: Module
type: container
name: my-container
...
tests:
  - name: unit
    command: [npm, test]
  - name: integ
    command: [npm, run, integ]
    dependencies:
      - some-service
...
```

Here we first define a `unit` test suite, which has no dependencies, and simply runs `npm test` in the container. The `integ` suite is similar but adds a _runtime dependency_. This means that before the `integ` test is run, Garden makes sure that `some-service` is running and up-to-date.

When you run `garden test` or `garden dev` we will run those tests. In both cases, the tests will be executed by running the container with the specified command _in your configured environment_ (as opposed to locally on the machine you're running the `garden` CLI from).

The names and commands to run are of course completely up to you, but we suggest naming the test suites consistently across your different modules.

See the [reference](../reference/module-types/container.md#tests) for all the configurable parameters for container tests.

## Running tasks

Tasks are defined very similarly to tests:

```yaml
kind: Module
type: container
name: my-container
...
tasks:
  - name: db-migrate
    command: [rake, db:migrate]
    dependencies:
      - my-database
...
```

In this example, we define a `db-migrate` task that runs `rake db:migrate` (which is commonly used for database migrations, but you can run anything you like of course). The task has a dependency on `my-database`, so that Garden will make sure the database is up and running before running the migration task.

Unlike tests, tasks can also be dependencies for services and other tasks. For example, you might define another task or a service with `db-migrate` as a dependency, so that it only runs after the migrations have been executed.

One thing to note, is that tasks should in most cases be _idempotent_, meaning that running the same task multiple times should be safe.

See the [reference](../reference/module-types/container.md#tasks) for all the configurable parameters for container tasks.

## Referencing from other modules

Modules can reference outputs from each other using [template strings](../using-garden/variables-and-templating.md#template-string-basics). `container` modules are, for instance, often referenced by other module types such as `helm` module types. For example:

```yaml
kind: Module
description: Helm chart for the worker container
type: helm
name: my-service
...
build:
  dependencies: [my-image]
values:
  image:
    name: ${modules.my-image.outputs.deployment-image-name}
    tag: ${modules.my-image.version}
```

Here, we declare `my-image` as a dependency for the `my-service` Helm chart. In order for the Helm chart to be able to reference the built container image, we must provide the correct image name and version.

For a full list of keys that are available for the `container` module type, take a look at the [outputs reference](../reference/module-types/container.md#outputs).

## Mounting volumes

`container` services, tasks and tests can all mount volumes, using _volume modules_. One such is the [`persistentvolumeclaim` module type](../reference/module-types/persistentvolumeclaim.md), supported by the `kubernetes` provider. To mount a volume, you need to define a volume module, and reference it using the `volumes` key on your services, tasks and/or tests.

Example:

```yaml
kind: Module
name: my-volume
type: persistentvolumeclaim
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
---
kind: Module
name: my-module
type: container
services:
  - name: my-service
    replicas: 1  # <- Important! Unless your volume supports ReadWriteMany, you can't run multiple replicas with it
    volumes:
      - name: my-volume
        module: my-volume
        containerPath: /volume
    ...
```

This will mount the `my-volume` PVC at `/volume` in the `my-service` service when it is run. The `my-volume` module creates a `PersistentVolumeClaim` resource in your project namespace, and the `spec` field is passed directly to the same field on the PVC resource.

{% hint style="warning" %}
Notice the `accessModes` field in the volume module above. The default storage classes in Kubernetes generally don't support being mounted by multiple Pods at the same time. If your volume module doesn't support the `ReadWriteMany` access mode, you must take care not to use the same volume in multiple services, tasks or tests, or multiple replicas. See [Shared volumes](#shared-volumes) below for how to share a single volume with multiple Pods.
{% endhint %}

You can do the same for tests and tasks using the [`tests.volumes`](../reference/module-types/container.md#testsvolumes) and [`tasks.volumes`](../reference/module-types/container.md#tasksvolumes) fields. `persistentvolumeclaim` volumes can of course also be referenced in `kubernetes` and
`helm` modules, since they are deployed as standard PersistentVolumeClaim resources.

Take a look at the [`persistentvolumeclaim` module type](../reference/module-types/persistentvolumeclaim.md) and [`container` module](../reference/module-types/container.md#servicesvolumes) docs for more details.

## Mounting Kubernetes ConfigMaps

Very similarly to the above example, you can also mount Kubernetes ConfigMaps on `container` modules using the [`configmap` module type](../reference/module-types/configmap.md), supported by the `kubernetes` provider. Here's a simple example:

Example:

```yaml
kind: Module
name: my-configmap
type: configmap
data:
  config.properties: |
    some: data
    or: something
---
kind: Module
name: my-module
type: container
services:
  - name: my-service
    volumes:
      - name: my-configmap
        module: my-configmap
        containerPath: /config
    ...
```

This mounts all the keys in the `data` field on the `my-configmap` module under the `/config` directory in the container. In this case, you'll find the file `/config/config.properties` there, with the value above (`some: data ...`) as the file contents.

You can do the same for tests and tasks using the [`tests.volumes`](../reference/module-types/container.md#testsvolumes) and [`tasks.volumes`](../reference/module-types/container.md#tasksvolumes) fields. `configmap` volumes can of course also be referenced in `kubernetes` and `helm` modules, since they are deployed as standard ConfigMap resources.

Take a look at the [`configmap` module type](../reference/module-types/configmap.md) and [`container` module](../reference/module-types/container.md#servicesvolumes) docs for more details.

### Shared volumes

For a volume to be shared between multiple replicas, or multiple services, tasks and/or tests, it needs to be configured with a storage class (using the `storageClassName` field) that supports the `ReadWriteMany` (RWX) access mode. The available storage classes that support RWX vary by cloud providers and cluster setups, and in many cases you need to define a `StorageClass` or deploy a _storage class provisioner_ to your cluster.

You can find a list of storage options and their supported access modes [here](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes). Here are a few commonly used RWX provisioners and storage classes:

* [NFS Server Provisioner](https://github.com/helm/charts/tree/master/stable/nfs-server-provisioner)
* [Azure File](https://docs.microsoft.com/en-us/azure/aks/azure-files-dynamic-pv)
* [AWS EFS Provisioner](https://github.com/helm/charts/tree/master/stable/efs-provisioner)
* [Ceph (via Rook)](https://rook.io/docs/rook/v1.2/ceph-filesystem.html)

Once any of those is set up you can create a `persistentvolumeclaim` module that uses the configured storage class. Here, for example, is how you might use a shared volume with a configured `azurefile` storage class:

```yaml
kind: Module
name: shared-volume
type: persistentvolumeclaim
spec:
  accessModes: [ReadWriteMany]
  resources:
    requests:
      storage: 1Gi
  storageClassName: azurefile
---
kind: Module
name: my-module
type: container
services:
  - name: my-service
    volumes:
      - &volume   # <- using a YAML anchor to re-use the volume spec in tasks and tests
        name: shared-volume
        module: shared-volume
        containerPath: /volume
    ...
tasks:
  - name: my-task
    volumes:
      - *volume
    ...
tests:
  - name: my-test
    volumes:
      - *volume
    ...
```

Here the same volume is used across a service, task and a test in the same module. You could similarly use the same volume across multiple container modules.
