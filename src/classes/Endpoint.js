const { unused, http, allOfType } = require("svcorelib");
const { resolve } = require("path");
const _http = require("http");

const convertFileFormat = require("../fileFormatConverter");
const parseURL = require("../parseURL");
const { isValidLang } = require("../languages");
const debug = require("../debug");

const settings = require("../../settings");
// TODO: load in with fs because require() has a cache
const endpointsTrFile = require(`../../${settings.endpoints.translationsFile}`);

let httpServer = require("../httpServer"); // needs to be re-loaded sometimes because of circular dependency bullshit


//#MARKER type stuff
unused("types:", _http);

/**
 * @typedef {Object} TranslatedStrings
 * @prop {string} lang Language code
 * @prop {string} text Translated text
 */

/**
 * @typedef {Object} EndpointMeta
 * @prop {Object} usage How to use this endpoint
 * @prop {string} usage.method HTTP method
 * @prop {string[]} usage.supportedParams An array of supported URL parameters
 * @prop {boolean} [unlisted] Makes the `/endpoints/` endpoint ignore this endpoint
 * @prop {boolean} [noLog] Prohibits the `logRequest` module from writing analytics data and from sending a console message
 * @prop {boolean} [skipRateLimitCheck] Prevents the rate limiter from being incremented
 */

/**
 * @typedef {Object} TranslationsObj
 * @prop {TranslatedStrings[]} names Display name translations of this endpoint
 * @prop {TranslatedStrings[]} descriptions Description translations of this endpoint
 */

//#MARKER MissingImplementationError
class MissingImplementationError extends Error {
    constructor(message)
    {
        super(message);
        this.name = "This member was not implemented correctly";
        this.date = new Date();

        if(Error.captureStackTrace)
            Error.captureStackTrace(this, MissingImplementationError);
    }
}

//#MARKER class def + constructor
/**
 * Base class for all of JokeAPI's endpoints
 * @since 2.4.0 - Implemented because of issue #243
 */
class Endpoint
{
    /**
     * Constructs a new object of class Endpoint  
     * This class is intended to be subclassed! Don't use it "raw" like this!
     * @param {string} pathName At which path this endpoint will be called
     * @param {EndpointMeta} meta Meta information about this endpoint
     */
    constructor(pathName, meta)
    {
        if(typeof pathName !== "string")
            throw new TypeError(`Parameter "pathName" is not of type string (got "${typeof pathName}")`);

        if(typeof meta !== "object")
            throw new TypeError(`Parameter "meta" is not of type object (got "${typeof meta}")`);
        
        /** @type {TranslationObj} */
        this.translations = Endpoint.getTranslations(pathName);

        this.pathName = pathName;
        this.meta = meta;

        /** @type {string[]} Positional URL path arguments - is an empty array if not set - override in the subclass' constructor if needed */
        this.positionalArguments = [];

        debug("Endpoint", `Instantiated endpoint at /${pathName}/ (method: ${this.meta.usage.method})`);
    }

    //#MARKER call
    /**
     * This method is run each time a client requests this endpoint  
     * Abstract method - to be overwritten!
     * @abstract ❗️ Abstract method - Override this, else a MissingImplementationError is thrown ❗️
     * @param {_http.IncomingMessage} req The HTTP server request
     * @param {_http.ServerResponse} res The HTTP server response
     * @param {string[]} url URL path array gotten from the URL parser module
     * @param {Object} params URL query params gotten from the URL parser module
     * @param {string} format The file format to respond with
     * @param {httpServer.HttpMetrics} httpMetrics
     * @throws Throws a MissingImplementationError if this method was not overwritten
     */
    call(req, res, url, params, format, httpMetrics)
    {
        unused(req, res, url, params, format, httpMetrics);
        throw new MissingImplementationError(`Method Endpoint.call() is an abstract method that needs to be overridden in a subclass of "Endpoint"`);
    }

    //#MARKER "normal" methods
    /**
     * Returns this endpoint's meta object
     * @returns {EndpointMeta}
     */
    getMeta()
    {
        return this.meta;
    }

    /**
     * Returns the path name at which this endpoint should be called
     * @returns {string}
     */
    getPathName()
    {
        return this.pathName;
    }

    /**
     * Returns the display name of this endpoint, in the specified language
     * @param {string} langCode
     * @returns {string} Returns the translation of value `settings.languages.defaultLanguage` if no translation was found
     */
    getDisplayName(langCode)
    {
        if(!isValidLang(langCode))
            throw new TypeError(`Parameter "langCode" is not a valid language code`);

        let dispName = this.translations.names.find(n => n.lang == langCode);

        // if dispName is undefined, no name exists for the provided langCode so default to the default language
        if(!dispName)
            dispName = this.translations.names.find(n => n.lang == settings.languages.defaultLanguage);

        if(!dispName)
            throw new Error(`No default language translation found for endpoint "${this.pathName}"`);

        return dispName.text;
    }

    /**
     * Returns the description of this endpoint, in the specified language
     * @param {string} langCode
     * @returns {string} Returns the translation of value `settings.languages.defaultLanguage` if no translation was found
     */
    getDescription(langCode)
    {
        if(!isValidLang(langCode))
            throw new TypeError(`Parameter "langCode" is not a valid language code`);

        let description = this.translations.descriptions.find(d => d.lang == langCode);

        // if description is undefined, no description exists for the provided langCode so default to the default language
        if(!description)
            description = this.translations.descriptions.find(d => d.lang == settings.languages.defaultLanguage);

        if(!description)
            throw new Error(`No default language translation found for endpoint "${this.pathName}"`);

        return description.text;
    }

    /**
     * Returns all positional URL path arguments
     * @returns {string[]}
     */
    getPositionalArguments()
    {
        if(!Array.isArray(this.positionalArguments) || (Array.isArray(this.positionalArguments) && this.positionalArguments.length > 0 && !allOfType(this.positionalArguments, "string")))
            throw new TypeError(`The member variable "positionalArguments" is not an array of strings or an empty array.`);

        return this.positionalArguments;
    }

    /**
     * Returns a string representation of this endpoint
     * @returns {string}
     */
    toString()
    {
        return `Endpoint /${this.getPathName()}/ - ${this.getDescription()}`;
    }

    //#MARKER static
    /**
     * Returns the language code, retrieved from a URL parameter object.  
     * If no language was specified in the `params`, returns the default language defined at `settings.languages.defaultLanguage` 
     * @static
     * @param {Object} params URL query params gotten from the URL parser module
     * @returns {string}
     */
    static getLang(params)
    {
        return (params && params["lang"]) ? params["lang"] : settings.languages.defaultLanguage;
    }

    /**
     * Static method that sends a response to the client.  
     * Runs file format auto-conversion, then pipes data to the client using `httpServer.pipeString()`
     * @static
     * @param {_http.ServerResponse} res
     * @param {string} format File format
     * @param {string} lang Language code
     * @param {Object} data JSON-compatible object - data to send to the client
     * @param {number} [statusCode] Status code (defaults to 200)
     */
    static respond(res, format, lang, data, statusCode)
    {
        if(!(res instanceof _http.ServerResponse))
            throw new TypeError(`Parameter "res" is not an instance of "http.ServerResponse"`);

        if(typeof format !== "string")
            throw new TypeError(`Parameter "format" is not of type "string"`);

        if(!isValidLang(lang))
            throw new TypeError(`Parameter "lang" is not a valid language code`);

        if(typeof data !== "object")
            throw new TypeError(`Parameter "data" is not of type "object"`);

        if(statusCode != undefined && typeof statusCode !== "number")
            throw new TypeError(`Parameter "statusCode" was set but is not of type "number"`);


        const responseText = convertFileFormat.auto(format, data, lang);

        statusCode = parseInt(statusCode);

        if(typeof statusCode != "number" || isNaN(statusCode) || statusCode < 100)
            statusCode = 200;

        return http.pipeString(res, responseText, parseURL.getMimeType(format), statusCode);
    }

    /**
     * Sends a file to the client
     * @static
     * @param {_http.ServerResponse} res
     * @param {string} mimeType MIME type
     * @param {string} lang Language code
     * @param {string} filePath Path to the file
     * @param {number} [statusCode] Status code (defaults to 200)
     */
    static respondWithFile(res, mimeType, lang, filePath, statusCode)
    {
        filePath = resolve(filePath);

        statusCode = parseInt(statusCode);

        if(typeof statusCode != "number" || isNaN(statusCode) || statusCode < 100)
            statusCode = 200;

        return http.pipeFile(res, filePath, mimeType, statusCode);
    }

    /**
     * Sends an encoded response to the client - Runs file format auto-conversion, tries to encode, then uses httpServer.pipeString()
     * @static
     * @param {_http.IncomingMessage} req
     * @param {_http.ServerResponse} res
     * @param {string} format File format
     * @param {string} lang Language code
     * @param {Object} data JSON-compatible object - data to send to the client
     * @param {number} [statusCode] Status code (defaults to 200)
     */
    static tryRespondEncoded(req, res, format, lang, data, statusCode)
    {
        if(!httpServer || (typeof httpServer == "object" && Object.keys(httpServer).length == 0)) // TODO: improve this - loading 1000 lines on each request is probably not a good idea (around 5x performance impact)
            httpServer = require("../httpServer");

        const responseText = convertFileFormat.auto(format, data, lang);

        statusCode = parseInt(statusCode);

        if(typeof statusCode != "number" || isNaN(statusCode) || statusCode < 100)
            statusCode = 200;

        return httpServer.tryServeEncoded(req, res, responseText, parseURL.getMimeType(format), statusCode);
    }

    /**
     * Returns the translations object of the specified endpoint  
     * @param {string} pathName At which path this endpoint will be called
     * @throws TypeError if the pathName is invalid
     * @returns {TranslationsObj}
     */
    static getTranslations(pathName)
    {
        // const endpointsTrFile = require("../data/translations/endpoints.json");

        /** @type {TranslationsObj} */
        let translations = {
            names: [],
            descriptions: []
        };

        // iterate over all endpoints
        Object.keys(endpointsTrFile.tr).forEach(ep => {
            if(ep != pathName) // find the endpoint that has been specified with `pathName`
                return;

            const names = endpointsTrFile.tr[ep].name;
            const descriptions = endpointsTrFile.tr[ep].desc;

            // iterate over the current endpoint's names
            Object.keys(names).forEach(lang => {
                let val = names[lang];

                translations.names.push({
                    lang,
                    text: val
                });
            });

            // iterate over the current endpoint's descriptions
            Object.keys(descriptions).forEach(lang => {
                let val = descriptions[lang];

                translations.descriptions.push({
                    lang,
                    text: val
                });
            });
        });

        return translations;
    }
}

module.exports = Endpoint;
module.exports.MissingImplementationError = MissingImplementationError;