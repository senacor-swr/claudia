/*global module, require */
var aws = require('aws-sdk'),
	Promise = require('bluebird'),
	templateFile = require('../util/template-file'),
	allowApiInvocation = require('./allow-api-invocation'),
	fs = Promise.promisifyAll(require('fs'));
module.exports = function rebuildWebApi(functionName, functionVersion, restApiId, requestedConfig, awsRegion) {
	'use strict';
	var iam = Promise.promisifyAll(new aws.IAM()),
		apiGateway = Promise.promisifyAll(new aws.APIGateway({region: awsRegion})),
		apiConfig,
		existingResources,
		rootResourceId,
		ownerId,
		inputTemplateJson,
		inputTemplateForm,
		getOwnerId = function () {
			return iam.getUserAsync().then(function (result) {
				ownerId = result.User.UserId;
			});
		},
		findByPath = function (resourceItems, path) {
			var result;
			resourceItems.forEach(function (item) {
				if (item.path === path) {
					result = item;
				}
			});
			return result;
		},
		getExistingResources = function () {
			return apiGateway.getResourcesAsync({restApiId: restApiId, limit: 499});
		},
		findRoot = function () {
			rootResourceId = findByPath(existingResources, '/').id;
			return rootResourceId;
		},
		createMethod = function (methodName, resourceId) {
			var addCodeMapper = function (response) {
				return apiGateway.putMethodResponseAsync({
					restApiId: restApiId,
					resourceId: resourceId,
					httpMethod: methodName,
					statusCode: response.code,
					responseModels: {
						'application/json': 'Empty'
					}
				}).then(function () {
					return apiGateway.putIntegrationResponseAsync({
						restApiId: restApiId,
						resourceId: resourceId,
						httpMethod: methodName,
						statusCode: response.code,
						selectionPattern: response.pattern,
						responseTemplates: {
							'application/json': ''
						}
					});
				});
			};
			return apiGateway.putMethodAsync({
				authorizationType: 'NONE', /*todo support config */
				httpMethod: methodName,
				resourceId: resourceId,
				restApiId: restApiId
			}).then(function () {
				return apiGateway.putIntegrationAsync({
					restApiId: restApiId,
					resourceId: resourceId,
					httpMethod: methodName,
					type: 'AWS',
					integrationHttpMethod: 'POST',
					requestTemplates: {
						'application/json': inputTemplateJson,
						'application/x-www-form-urlencoded': inputTemplateForm
					},
					uri: 'arn:aws:apigateway:' + awsRegion + ':lambda:path/2015-03-31/functions/arn:aws:lambda:' + awsRegion + ':' + ownerId + ':function:' + functionName + ':${stageVariables.lambdaVersion}/invocations'
				});
			}).then(function () {
				return Promise.map([{code: '200', pattern: '^$'}, {code: '500', pattern: ''}], addCodeMapper, {concurrency: 1});
			});
		},
		createCorsHandler = function (resourceId, allowedMethods) {
			return apiGateway.putMethodAsync({
				authorizationType: 'NONE', /*todo support config */
				httpMethod: 'OPTIONS',
				resourceId: resourceId,
				restApiId: restApiId
			}).then(function () {
				return apiGateway.putIntegrationAsync({
					restApiId: restApiId,
					resourceId: resourceId,
					httpMethod: 'OPTIONS',
					type: 'MOCK',
					requestTemplates: {
						'application/json': '{\"statusCode\": 200}'
					}
				});
			}).then(function () {
				return apiGateway.putMethodResponseAsync({
					restApiId: restApiId,
					resourceId: resourceId,
					httpMethod: 'OPTIONS',
					statusCode: '200',
					responseModels: {
						'application/json': 'Empty'
					},
					responseParameters: {
						'method.response.header.Access-Control-Allow-Headers': false,
						'method.response.header.Access-Control-Allow-Methods': false,
						'method.response.header.Access-Control-Allow-Origin': false
					}
				});
			}).then(function () {
				return apiGateway.putIntegrationResponseAsync({
					restApiId: restApiId,
					resourceId: resourceId,
					httpMethod: 'OPTIONS',
					statusCode: '200',
					responseTemplates: {
						'application/json': ''
					},
					responseParameters: {
						'method.response.header.Access-Control-Allow-Headers': '\'Content-Type,X-Amz-Date,Authorization,X-Api-Key\'',
						'method.response.header.Access-Control-Allow-Methods': '\'' + allowedMethods.join(',') + ',OPTIONS\'',
						'method.response.header.Access-Control-Allow-Origin': '\'*\''
					}
				});
			});
		},
		createPath = function (path) {
			var resourceId,
				supportedMethods = Object.keys(apiConfig.routes[path]);
			return apiGateway.createResourceAsync({
				restApiId: restApiId,
				parentId: rootResourceId,
				pathPart: path
			}).then(function (resource) {
				resourceId = resource.id;
			}).then(function () {
				var createMethodMapper = function (methodName) {
					return createMethod(methodName, resourceId);
				};
				return Promise.map(supportedMethods, createMethodMapper, {concurrency: 1});
			}).then(function () {
				return createCorsHandler(resourceId, supportedMethods);
			});
		},
		dropSubresources = function () {
			var removeResourceMapper = function (resource) {
				if (resource.id !== rootResourceId) {
					return apiGateway.deleteResourceAsync({
						resourceId: resource.id,
						restApiId: restApiId
					});
				}
			};
			return Promise.map(existingResources, removeResourceMapper, {concurrency: 1});
		},
		readTemplates = function () {
			return fs.readFileAsync(templateFile('apigw-params-json.txt'), 'utf8')
			.then(function (inputTemplate) {
				inputTemplateJson = inputTemplate;
			}).then(function () {
				return fs.readFileAsync(templateFile('apigw-params-form.txt'), 'utf8');
			}).then(function (inputTemplate) {
				inputTemplateForm = inputTemplate;
			});
		},
		rebuildApi = function () {
			return allowApiInvocation(functionName, functionVersion, restApiId, ownerId, awsRegion)
			.then(getExistingResources)
			.then(function (resources) {
				existingResources = resources.items;
				return existingResources;
			})
			.then(findRoot)
			.then(dropSubresources)
			.then(function () {
				return Promise.map(Object.keys(apiConfig.routes), createPath, {concurrency: 1});
			});
		},
		deployApi = function () {
			return apiGateway.createDeploymentAsync({
				restApiId: restApiId,
				stageName: functionVersion,
				variables: {
					lambdaVersion: functionVersion
				}
			});
		},
		upgradeConfig = function (config) {
			var result;
			if (config.version === 2) {
				return config;
			}
			result = { version: 2, routes: {} };
			Object.keys(config).forEach(function (route) {
				result.routes[route] = {};
				config[route].methods.forEach(function (methodName) {
					result.routes[route][methodName] = {};
				});
			});
			return result;
		};
	apiConfig = upgradeConfig(requestedConfig);
	return getOwnerId()
		.then(readTemplates)
		.then(rebuildApi)
		.then(deployApi);
};


