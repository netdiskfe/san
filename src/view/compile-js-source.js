/**
 * @file 将组件编译成 render 方法的 js 源码
 * @author errorrik(errorrik@gmail.com)
 */


var each = require('../util/each');
var camel2kebab = require('../util/camel2kebab');
var IndexedList = require('../util/indexed-list');
var guid = require('../util/guid');
var parseExpr = require('../parser/parse-expr');
var createANode = require('../parser/create-a-node');
var autoCloseTags = require('../browser/auto-close-tags');
var CompileSourceBuffer = require('./compile-source-buffer');
var compileExprSource = require('./compile-expr-source');
var postComponentBinds = require('./post-component-binds');
var serializeANode = require('./serialize-a-node');

// #[begin] ssr

/**
 * 生成序列化时起始桩的html
 *
 * @param {string} type 桩类型标识
 * @param {string?} content 桩内的内容
 * @return {string}
 */
function serializeStump(type, content) {
    return '<!--s-' + type + (content ? ':' + content : '') + '-->';
}

/**
 * 生成序列化时结束桩的html
 *
 * @param {string} type 桩类型标识
 * @return {string}
 */
function serializeStumpEnd(type) {
    return '<!--/s-' + type + '-->';
}

/**
 * element 的编译方法集合对象
 *
 * @inner
 */
var elementSourceCompiler = {

    /* eslint-disable max-params */
    /**
     * 编译元素标签头
     *
     * @param {CompileSourceBuffer} sourceBuffer 编译源码的中间buffer
     * @param {string} tagName 标签名
     * @param {IndexedList} props 属性列表
     * @param {IndexedList} binds 绑定信息列表
     * @param {Array} events 绑定事件列表
     * @param {Object} aNode 对应的抽象节点对象
     * @param {string?} extraProp 额外的属性串
     * @param {boolean?} isComponent 是否组件
     * @param {boolean?} isClose 是否闭合
     */
    tagStart: function (sourceBuffer, tagName, props, binds, events, aNode, extraProp, isComponent, isClose) {
        sourceBuffer.joinString('<' + tagName);
        sourceBuffer.joinString(extraProp || '');

        binds.each(function (bindInfo) {
            if (isComponent) {
                sourceBuffer.joinString(
                    ' prop-' + camel2kebab(bindInfo.name)
                        + (bindInfo.raw ? '="' + bindInfo.raw + '"' : '')
                );
            }
            else if (bindInfo.raw) {
                sourceBuffer.joinString(
                    ' prop-' + camel2kebab(bindInfo.name) + '="' + bindInfo.raw + '"'
                );
            }

        });

        var htmlDirective = aNode.directives.get('html');
        if (htmlDirective) {
            sourceBuffer.joinString(' s-html="' + htmlDirective.raw + '"');
        }

        each(events, function (event) {
            sourceBuffer.joinString(' on-' + event.name + '="' + event.expr.raw + '"');
        });

        props.each(function (prop) {
            if (prop.name === 'value') {
                switch (tagName) {
                    case 'textarea':
                        return;

                    case 'select':
                        sourceBuffer.addRaw('$selectValue = '
                            + compileExprSource.expr(prop.expr)
                            + ' || "";'
                        );
                        return;

                    case 'option':
                        sourceBuffer.addRaw('$optionValue = '
                            + compileExprSource.expr(prop.expr)
                            + ';'
                        );
                        // value
                        sourceBuffer.addRaw('if ($optionValue != null) {');
                        sourceBuffer.joinRaw('" value=\\"" + $optionValue + "\\""');
                        sourceBuffer.addRaw('}');

                        // selected
                        sourceBuffer.addRaw('if ($optionValue === $selectValue) {');
                        sourceBuffer.joinString(' selected');
                        sourceBuffer.addRaw('}');
                        return;
                }
            }

            switch (prop.name) {
                case 'draggable':
                case 'readonly':
                case 'disabled':
                case 'multiple':
                    if (prop.raw === '') {
                        sourceBuffer.joinString(' ' + prop.name);
                    }
                    else {
                        sourceBuffer.joinRaw('boolAttrFilter("' + prop.name + '", '
                            + compileExprSource.expr(prop.expr)
                            + ')'
                        );
                    }
                    break;

                case 'checked':
                    if (tagName === 'input') {
                        var valueProp = props.get('value');
                        var valueCode = compileExprSource.expr(valueProp.expr);

                        if (valueProp) {
                            switch (props.get('type').raw) {
                                case 'checkbox':
                                    sourceBuffer.addRaw('if (contains('
                                        + compileExprSource.expr(prop.expr)
                                        + ', '
                                        + valueCode
                                        + ')) {'
                                    );
                                    sourceBuffer.joinString(' checked');
                                    sourceBuffer.addRaw('}');
                                    break;

                                case 'radio':
                                    sourceBuffer.addRaw('if ('
                                        + compileExprSource.expr(prop.expr)
                                        + ' === '
                                        + valueCode
                                        + ') {'
                                    );
                                    sourceBuffer.joinString(' checked');
                                    sourceBuffer.addRaw('}');
                                    break;
                            }
                        }
                    }
                    break;

                default:
                    if (prop.expr.value) {
                        sourceBuffer.joinString(' ' + prop.name + '="' + prop.expr.value + '"');
                    }
                    else {
                        sourceBuffer.joinRaw('attrFilter("' + prop.name + '", '
                            + compileExprSource.expr(prop.expr)
                            + ')'
                        );
                    }
                    break;
            }
        });

        sourceBuffer.joinString(isClose ? '/>' : '>');
    },
    /* eslint-enable max-params */

    /**
     * 编译元素闭合
     *
     * @param {CompileSourceBuffer} sourceBuffer 编译源码的中间buffer
     * @param {string} tagName 标签名
     */
    tagEnd: function (sourceBuffer, tagName) {
        if (!autoCloseTags[tagName]) {
            sourceBuffer.joinString('</' + tagName + '>');
        }

        if (tagName === 'select') {
            sourceBuffer.addRaw('$selectValue = null;');
        }

        if (tagName === 'option') {
            sourceBuffer.addRaw('$optionValue = null;');
        }
    },

    /**
     * 编译元素内容
     *
     * @param {CompileSourceBuffer} sourceBuffer 编译源码的中间buffer
     * @param {ANode} aNode 元素的抽象节点信息
     * @param {Component} owner 所属组件实例环境
     */
    inner: function (sourceBuffer, aNode, owner) {
        // inner content
        if (aNode.tagName === 'textarea') {
            var valueProp = aNode.props.get('value');
            if (valueProp) {
                sourceBuffer.joinRaw('escapeHTML('
                    + compileExprSource.expr(valueProp.expr)
                    + ')'
                );
            }

            return;
        }

        var htmlDirective = aNode.directives.get('html');
        if (htmlDirective) {
            sourceBuffer.joinExpr(htmlDirective.value);
        }
        else {
            /* eslint-disable no-use-before-define */
            each(aNode.children, function (aNodeChild) {
                sourceBuffer.addRaw(aNodeCompiler.compile(aNodeChild, sourceBuffer, owner));
            });
            /* eslint-enable no-use-before-define */
        }
    }
};

/**
 * ANode 的编译方法集合对象
 *
 * @inner
 */
var aNodeCompiler = {

    /**
     * 编译节点
     *
     * @param {ANode} aNode 抽象节点
     * @param {CompileSourceBuffer} sourceBuffer 编译源码的中间buffer
     * @param {Component} owner 所属组件实例环境
     * @param {Object} extra 编译所需的一些额外信息
     */
    compile: function (aNode, sourceBuffer, owner, extra) {
        extra = extra || {};
        var compileMethod = 'compileElement';

        if (aNode.isText) {
            compileMethod = 'compileText';
        }
        else if (aNode.directives.get('if')) {
            compileMethod = 'compileIf';
        }
        else if (aNode.directives.get('for')) {
            compileMethod = 'compileFor';
        }
        else if (aNode.tagName === 'slot') {
            compileMethod = 'compileSlot';
        }
        else if (aNode.tagName === 'template') {
            compileMethod = 'compileTemplate';
        }
        else {
            var ComponentType = owner.components[aNode.tagName];
            if (ComponentType) {
                compileMethod = 'compileComponent';
                extra.ComponentClass = ComponentType;
            }
        }

        aNodeCompiler[compileMethod](aNode, sourceBuffer, owner, extra);
    },

    /**
     * 编译文本节点
     *
     * @param {ANode} aNode 节点对象
     * @param {CompileSourceBuffer} sourceBuffer 编译源码的中间buffer
     */
    compileText: function (aNode, sourceBuffer) {
        var value = aNode.textExpr.value;

        if (value == null) {
            sourceBuffer.joinString('<!--s-text:' + aNode.text + '-->');
            sourceBuffer.joinExpr(aNode.textExpr);
            sourceBuffer.joinString('<!--/s-text-->');
        }
        else {
            sourceBuffer.joinString(value);
        }
    },

    /**
     * 编译template节点
     *
     * @param {ANode} aNode 节点对象
     * @param {CompileSourceBuffer} sourceBuffer 编译源码的中间buffer
     * @param {Component} owner 所属组件实例环境
     */
    compileTemplate: function (aNode, sourceBuffer, owner) {
        sourceBuffer.joinString(serializeStump('tpl'));
        elementSourceCompiler.inner(sourceBuffer, aNode, owner);
        sourceBuffer.joinString(serializeStumpEnd('tpl'));
    },

    /**
     * 编译 if 节点
     *
     * @param {ANode} aNode 节点对象
     * @param {CompileSourceBuffer} sourceBuffer 编译源码的中间buffer
     * @param {Component} owner 所属组件实例环境
     */
    compileIf: function (aNode, sourceBuffer, owner) {
        sourceBuffer.addRaw('(function () {');

        sourceBuffer.joinString(serializeStump('if', serializeANode(aNode)));

        sourceBuffer.addRaw('var ifIndex = null;');

        // for ifIndex
        var ifDirective = aNode.directives.get('if');
        sourceBuffer.addRaw('if (' + compileExprSource.expr(ifDirective.value) + ') {');
        sourceBuffer.addRaw('    ifIndex = -1;');
        sourceBuffer.addRaw('}');
        each(aNode.elses, function (elseANode, index) {
            var elifDirective = elseANode.directives.get('elif');
            if (elifDirective) {
                sourceBuffer.addRaw('else if (' + compileExprSource.expr(elifDirective.value) + ') {');
            }
            else {
                sourceBuffer.addRaw('else {');
            }

            sourceBuffer.addRaw('    ifIndex = ' + index + ';');
            sourceBuffer.addRaw('}');
        });

        sourceBuffer.addRaw('if (ifIndex != null) {');
        sourceBuffer.joinRaw('\"<!--\" + ifIndex + \"-->\"');
        sourceBuffer.addRaw('}');

        // for output main if html
        sourceBuffer.addRaw('if (ifIndex === -1) {');
        sourceBuffer.addRaw(
            aNodeCompiler.compile(
                rinseANode(aNode),
                sourceBuffer,
                owner
            )
        );
        sourceBuffer.addRaw('}');

        // for output else html
        each(aNode.elses, function (elseANode, index) {
            var elifDirective = elseANode.directives.get('elif');
            sourceBuffer.addRaw(elifDirective ? 'else if (ifIndex === ' + index + ') {' : 'else {');
            sourceBuffer.addRaw(
                aNodeCompiler.compile(
                    rinseANode(elseANode),
                    sourceBuffer,
                    owner
                )
            );
            sourceBuffer.addRaw('}');
        });

        sourceBuffer.joinString(serializeStumpEnd('if'));
        sourceBuffer.addRaw('})();');


        /**
         * 清洗 if aNode，返回纯净无 if 指令的 aNode
         *
         * @param {ANode} ifANode 节点对象
         * @return {ANode}
         */
        function rinseANode(ifANode) {
            var result = createANode({
                children: ifANode.children,
                props: ifANode.props,
                events: ifANode.events,
                tagName: ifANode.tagName,
                directives: (new IndexedList()).concat(ifANode.directives)
            });
            result.directives.remove('if');
            result.directives.remove('elif');
            result.directives.remove('else');

            return result;
        }
    },

    /**
     * 编译 for 节点
     *
     * @param {ANode} aNode 节点对象
     * @param {CompileSourceBuffer} sourceBuffer 编译源码的中间buffer
     * @param {Component} owner 所属组件实例环境
     */
    compileFor: function (aNode, sourceBuffer, owner) {
        var forElementANode = createANode({
            children: aNode.children,
            props: aNode.props,
            events: aNode.events,
            tagName: aNode.tagName,
            directives: (new IndexedList()).concat(aNode.directives)
        });
        forElementANode.directives.remove('for');

        var forDirective = aNode.directives.get('for');
        var itemName = forDirective.item.raw;
        var indexName = forDirective.index.raw;
        var listName = compileExprSource.dataAccess(forDirective.list);

        if (indexName === '$index') {
            indexName = guid();
        }

        // start stump
        sourceBuffer.joinString(serializeStump('for', serializeANode(aNode)));

        sourceBuffer.addRaw('for ('
            + 'var ' + indexName + ' = 0; '
            + indexName + ' < ' + listName + '.length; '
            + indexName + '++) {'
        );
        sourceBuffer.addRaw('componentCtx.data.' + indexName + '=' + indexName + ';');
        sourceBuffer.addRaw('componentCtx.data.' + itemName + '= ' + listName + '[' + indexName + '];');
        sourceBuffer.addRaw(
            aNodeCompiler.compile(
                forElementANode,
                sourceBuffer,
                owner
            )
        );
        sourceBuffer.addRaw('}');

        // stop stump
        sourceBuffer.joinString(serializeStumpEnd('for'));
    },

    /**
     * 编译 slot 节点
     *
     * @param {ANode} aNode 节点对象
     * @param {CompileSourceBuffer} sourceBuffer 编译源码的中间buffer
     * @param {Component} owner 所属组件实例环境
     */
    compileSlot: function (aNode, sourceBuffer, owner) {
        var nameProp = aNode.props.get('name');
        var givenSlots = owner.aNode.givenSlots;
        var givenChildren;
        if (givenSlots) {
            givenChildren = nameProp 
                ? givenSlots.named[nameProp.raw] 
                : givenSlots.noname;
        }
        
        var isInserted = 0;
        var children = aNode.children;
        if (givenChildren) {
            isInserted = 1;
            children = givenChildren;
            owner = owner.owner;
        }

        var stumpText = (!isInserted ? '!' : '')
            + serializeANode({
                tagName: aNode.tagName,
                vars: aNode.vars,
                props: aNode.props,
                directives: aNode.directives
            });



        sourceBuffer.joinString(serializeStump('slot', stumpText));

        if (isInserted) {
            sourceBuffer.addRaw('var _slotCtx = componentCtx.owner;');
        }
        else {
            sourceBuffer.addRaw('var _slotCtx = componentCtx;');
        }

        if (aNode.vars) {
            sourceBuffer.addRaw('_slotCtx = {data: {}, filters: _slotCtx.filters, callFilter: _slotCtx.callFilter};');
            each(aNode.vars, function (varItem) {
                sourceBuffer.addRaw(
                    '_slotCtx.data["' + varItem.name + '"] = '
                    + compileExprSource.expr(varItem.expr)
                    + ';'
                );
            });
        }

        sourceBuffer.addRaw('(function (componentCtx) {');


        each(children, function (aNodeChild) {
            sourceBuffer.addRaw(aNodeCompiler.compile(aNodeChild, sourceBuffer, owner));
        });


        sourceBuffer.addRaw('})(_slotCtx);');
        sourceBuffer.addRaw('_slotCtx = null;');

        sourceBuffer.joinString(serializeStumpEnd('slot'));
    },

    /**
     * 编译普通节点
     *
     * @param {ANode} aNode 节点对象
     * @param {CompileSourceBuffer} sourceBuffer 编译源码的中间buffer
     * @param {Component} owner 所属组件实例环境
     * @param {Object} extra 编译所需的一些额外信息
     */
    compileElement: function (aNode, sourceBuffer, owner, extra) {
        extra = extra || {};
        if (aNode.tagName === 'option'
            && !aNode.props.get('value')
            && aNode.children[0]
        ) {
            aNode.props.push({
                name: 'value',
                expr: aNode.children[0].textExpr
            });
        }

        elementSourceCompiler.tagStart(
            sourceBuffer,
            aNode.tagName,
            aNode.props,
            aNode.props,
            aNode.events,
            aNode,
            extra.prop
        );

        elementSourceCompiler.inner(sourceBuffer, aNode, owner);
        elementSourceCompiler.tagEnd(sourceBuffer, aNode.tagName);
    },

    /**
     * 编译组件节点
     *
     * @param {ANode} aNode 节点对象
     * @param {CompileSourceBuffer} sourceBuffer 编译源码的中间buffer
     * @param {Component} owner 所属组件实例环境
     * @param {Object} extra 编译所需的一些额外信息
     * @param {Function} extra.ComponentClass 对应组件类
     */
    compileComponent: function (aNode, sourceBuffer, owner, extra) {
        var ComponentClass = extra.ComponentClass;
        var component = new ComponentClass({
            aNode: aNode,
            owner: owner,
            subTag: aNode.tagName
        });

        var givenData = [];

        postComponentBinds(aNode.props);
        component.binds.each(function (prop) {
            givenData.push(
                compileExprSource.stringLiteralize(prop.name)
                + ':'
                + compileExprSource.expr(prop.expr)
            );
        });

        sourceBuffer.addRaw('html += (');
        sourceBuffer.addRendererStart();
        compileComponentSource(sourceBuffer, component, extra && extra.prop);
        sourceBuffer.addRendererEnd();
        sourceBuffer.addRaw(')({' + givenData.join(',\n') + '}, componentCtx);');
    }
};

/* eslint-disable guard-for-in */

/**
 * 生成组件 renderer 时 ctx 对象构建的代码
 *
 * @inner
 * @param {CompileSourceBuffer} sourceBuffer 编译源码的中间buffer
 * @param {Object} component 组件实例
 * @param {string?} extraProp 额外的属性串
 */
function compileComponentSource(sourceBuffer, component, extraProp) {
    sourceBuffer.addRaw(genComponentContextCode(component));
    sourceBuffer.addRaw('componentCtx.owner = parentCtx;');
    sourceBuffer.addRaw('data = extend(componentCtx.data, data);');
    sourceBuffer.addRaw('for (var $i = 0; $i < componentCtx.computedNames.length; $i++) {');
    sourceBuffer.addRaw('var $computedName = componentCtx.computedNames[$i];');
    sourceBuffer.addRaw('data[$computedName] = componentCtx.computed[$computedName]();');
    sourceBuffer.addRaw('}');

    extraProp = extraProp || '';
    if (component.subTag) {
        extraProp += ' s-component="' + component.subTag + '"';
    }

    var refDirective = component.aNode.directives.get('ref');
    if (refDirective) {
        extraProp += ' s-ref="' + refDirective.value.raw + '"';
    }

    var eventDeclarations = [];
    for (var key in component.listeners) {
        each(component.listeners[key], function (listener) {
            if (listener.declaration) {
                eventDeclarations.push(listener.declaration);
            }
        });
    }

    elementSourceCompiler.tagStart(
        sourceBuffer,
        component.tagName,
        component.props,
        component.binds,
        eventDeclarations,
        component.aNode,
        extraProp,
        1
    );

    if (!component.owner) {
        sourceBuffer.joinString('<!--s-data:');
        sourceBuffer.joinDataStringify();
        sourceBuffer.joinString('-->');
    }

    elementSourceCompiler.inner(sourceBuffer, component.aNode, component);
    elementSourceCompiler.tagEnd(sourceBuffer, component.tagName);
}

var stringifier = {
    obj: function (source) {
        var prefixComma;
        var result = '{';

        for (var key in source) {
            if (prefixComma) {
                result += ',';
            }
            prefixComma = 1;

            result += compileExprSource.stringLiteralize(key) + ':' + stringifier.any(source[key]);
        }

        return result + '}';
    },

    arr: function (source) {
        var prefixComma;
        var result = '[';

        each(source, function (value) {
            if (prefixComma) {
                result += ',';
            }
            prefixComma = 1;

            result += stringifier.any(value);
        });

        return result + ']';
    },

    str: function (source) {
        return compileExprSource.stringLiteralize(source);
    },

    date: function (source) {
        return 'new Date(' + source.getTime() + ')';
    },

    any: function (source) {
        switch (typeof source) {
            case 'string':
                return stringifier.str(source);

            case 'number':
                return '' + source;

            case 'boolean':
                return source ? 'true' : 'false';

            case 'object':
                if (!source) {
                    return null;
                }

                if (source instanceof Array) {
                    return stringifier.arr(source);
                }

                if (source instanceof Date) {
                    return stringifier.date(source);
                }

                return stringifier.obj(source);
        }

        throw new Error('Cannot Stringify:' + source);
    }
};

/**
 * 生成组件 renderer 时 ctx 对象构建的代码
 *
 * @inner
 * @param {Object} component 组件实例
 * @return {string}
 */
function genComponentContextCode(component) {
    var code = ['var componentCtx = {'];

    // filters
    code.push('filters: {');
    var filterCode = [];
    for (var key in component.filters) {
        var filter = component.filters[key];

        if (typeof filter === 'function') {
            filterCode.push(key + ': ' + filter.toString());
        }
    }
    code.push(filterCode.join(','));
    code.push('},');

    code.push(
        'callFilter: function (name, args) {',
        '    var filter = this.filters[name] || DEFAULT_FILTERS[name];',
        '    if (typeof filter === "function") {',
        '        return filter.apply(this, args);',
        '    }',
        '},'
    );

    /* eslint-disable no-redeclare */
    // computed obj
    code.push('computed: {');
    var computedCode = [];
    for (var key in component.computed) {
        var computed = component.computed[key];

        if (typeof computed === 'function') {
            computedCode.push(key + ': '
                + computed.toString().replace(
                    /this.data.get\(([^\)]+)\)/g,
                    function (match, exprLiteral) {
                        var exprStr = (new Function('return ' + exprLiteral))();
                        var expr = parseExpr(exprStr);

                        return compileExprSource.expr(expr);
                    })
            );
        }
    }
    code.push(computedCode.join(','));
    code.push('},');

    // computed names
    code.push('computedNames: [');
    computedCode = [];
    for (var key in component.computed) {
        var computed = component.computed[key];

        if (typeof computed === 'function') {
            computedCode.push('"' + key + '"');
        }
    }
    code.push(computedCode.join(','));
    code.push('],');
    /* eslint-enable no-redeclare */

    // data
    code.push('data: ' + stringifier.any(component.data.get()) + ',');

    // tagName
    code.push('tagName: "' + component.tagName + '"');
    code.push('};');

    return code.join('\n');
}

/* eslint-enable guard-for-in */

/* eslint-disable no-unused-vars */
/* eslint-disable fecs-camelcase */

/**
 * 组件编译的模板函数
 *
 * @inner
 */
function componentCompilePreCode() {
    var $version = '##version##';

    function extend(target, source) {
        if (source) {
            Object.keys(source).forEach(function (key) {
                target[key] = source[key];
            });
        }

        return target;
    }

    function each(array, iterator) {
        if (array && array.length > 0) {
            for (var i = 0, l = array.length; i < l; i++) {
                if (iterator(array[i], i) === false) {
                    break;
                }
            }
        }
    }

    function contains(array, value) {
        var result;
        each(array, function (item) {
            result = item === value;
            return !result;
        });

        return result;
    }

    var HTML_ENTITY = {
        /* jshint ignore:start */
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        /* eslint-disable quotes */
        "'": '&#39;'
        /* eslint-enable quotes */
        /* jshint ignore:end */
    };

    function htmlFilterReplacer(c) {
        return HTML_ENTITY[c];
    }

    function escapeHTML(source) {
        if (source == null) {
            return '';
        }

        return String(source).replace(/[&<>"']/g, htmlFilterReplacer);
    }

    var DEFAULT_FILTERS = {
        html: escapeHTML,
        url: encodeURIComponent,
        raw: function (source) {
            return source;
        },
        _class: function (source) {
            if (source instanceof Array) {
                return source.join(' ');
            }

            return source;
        },
        _style: function (source) {
            if (typeof source === 'object') {
                var result = '';
                if (source) {
                    Object.keys(source).forEach(function (key) {
                        result += key + ':' + source[key] + ';';
                    });
                }

                return result;
            }

            return source || '';
        },
        _sep: function (source, sep) {
            return source ? sep + source : '';
        }
    };

    function attrFilter(name, value) {
        if (value) {
            return ' ' + name + '="' + value + '"';
        }

        return '';
    }

    function boolAttrFilter(name, value) {
        if (value && value !== 'false' && value !== '0') {
            return ' ' + name;
        }

        return '';
    }

    function stringLiteralize(source) {
        return '"'
            + source
                .replace(/\x5C/g, '\\\\')
                .replace(/"/g, '\\"')
                .replace(/\x0A/g, '\\n')
                .replace(/\x09/g, '\\t')
                .replace(/\x0D/g, '\\r')
            + '"';
    }

    var stringifier = {
        obj: function (source) {
            var prefixComma;
            var result = '{';

            Object.keys(source).forEach(function (key) {
                if (prefixComma) {
                    result += ',';
                }
                prefixComma = 1;

                result += stringLiteralize(key) + ':' + stringifier.any(source[key]);
            });

            return result + '}';
        },

        arr: function (source) {
            var prefixComma;
            var result = '[';

            each(source, function (value) {
                if (prefixComma) {
                    result += ',';
                }
                prefixComma = 1;

                result += stringifier.any(value);
            });

            return result + ']';
        },

        str: function (source) {
            return stringLiteralize(source);
        },

        date: function (source) {
            return 'new Date(' + source.getTime() + ')';
        },

        any: function (source) {
            switch (typeof source) {
                case 'string':
                    return stringifier.str(source);

                case 'number':
                    return '' + source;

                case 'boolean':
                    return source ? 'true' : 'false';

                case 'object':
                    if (!source) {
                        return null;
                    }

                    if (source instanceof Array) {
                        return stringifier.arr(source);
                    }

                    if (source instanceof Date) {
                        return stringifier.date(source);
                    }

                    return stringifier.obj(source);
            }

            throw new Error('Cannot Stringify:' + source);
        }
    };
}
/* eslint-enable no-unused-vars */
/* eslint-enable fecs-camelcase */

/**
 * 将组件编译成 render 方法的 js 源码
 *
 * @param {Function} ComponentClass 组件类
 * @return {string}
 */
function compileJSSource(ComponentClass) {
    var sourceBuffer = new CompileSourceBuffer();

    sourceBuffer.addRendererStart();
    sourceBuffer.addRaw(
        componentCompilePreCode.toString()
            .split('\n')
            .slice(1)
            .join('\n')
            .replace(/\}\s*$/, '')
    );

    // 先初始化个实例，让模板编译成 ANode，并且能获得初始化数据
    var component = new ComponentClass();

    compileComponentSource(sourceBuffer, component);
    sourceBuffer.addRendererEnd();
    return sourceBuffer.toCode();
}
// #[end]

exports = module.exports = compileJSSource;
