var express = require('express')
var _ = require('lodash')
var pluralize = require('pluralize')
var utils = require('../utils')

const operators = ['~=', '=~', '!=', '<=', '>=', '<', '>', '\\|=', '=', '~']
const operatorsRegex = new RegExp('(' + operators.join('|') + ')')

module.exports = function (db, name) {
  // Create router
  var router = express.Router()

  // Embed function used in GET /name and GET /name/id
  function embed (resource, e) {
    e && [].concat(e)
      .forEach(function (externalResource) {
        if (db.get(externalResource).value) {
          var query = {}
          var singularResource = pluralize.singular(name)
          query[singularResource + 'Id'] = resource.id
          resource[externalResource] = db.get(externalResource).filter(query).value()
        }
      })
  }

  // Expand function used in GET /name and GET /name/id
  function expand (resource, e) {
    e && [].concat(e)
      .forEach(function (innerResource) {
        var plural = pluralize(innerResource)
        if (db.get(plural).value()) {
          var prop = innerResource + 'Id'
          resource[innerResource] = db.get(plural).getById(resource[prop]).value()
        }
      })
  }

  function getFullURL (req) {
    return req.protocol + '://' + req.get('host') + req.originalUrl
  }

  // GET /name
  // GET /name?q=
  // GET /name?attr=&attr=
  // GET /name?_end=&
  // GET /name?_start=&_end=&
  // GET /name?_embed=&_expand=
  function list (req, res, next) {
    // Resource chain
    var chain = db.get(name)

    // Remove q, _start, _end, ... from req.query to avoid filtering using those
    // parameters
    var _q = req.query._q
    var _offset = req.query._offset
    var _end = req.query._end
    var _page = req.query._page
    var _sort = req.query._sort
    var _limit = req.query._limit
    var _embed = req.query._embed
    var _expand = req.query._expand
    var _fields = req.query._fields
    var _filter = req.query._filter
    delete req.query._q
    delete req.query._offset
    delete req.query._end
    delete req.query._sort
    delete req.query._limit
    delete req.query._embed
    delete req.query._expand
    delete req.query._fields

    // Automatically delete query parameters that can't be found
    // in the database
    Object.keys(req.query).forEach(function (query) {
      var arr = db.get(name).value()
      for (var i in arr) {
        if (
          _.has(arr[i], query) ||
          query === 'callback' ||
          query === '_' ||
          query.indexOf('_lte') !== -1 ||
          query.indexOf('_gte') !== -1 ||
          query.indexOf('_ne') !== -1 ||
          query.indexOf('_like') !== -1
        ) return
      }
      delete req.query[query]
    })

    if (_q) {
      // Full-text search
      _q = _q.toLowerCase()

      chain = chain.filter(function (obj) {
        for (var key in obj) {
          var value = obj[key]
          if (db._.deepQuery(value, _q)) {
            return true
          }
        }
      })
    }

    var filterMapping = {}

    if (_filter) {
      var filters = _filter.split(',')
      filters.forEach(function (filter) {
        var filterParts = filter.split(operatorsRegex)
        if (filterParts.length !== 3) {
          return
        }
        var key = filterParts[0]
        var op = filterParts[1]
        var value = filterParts[2]

        if (!filterMapping[key + op]) {
          filterMapping[key + op] = {value: []}
        }

        filterMapping[key + op].value.push(value)
        filterMapping[key + op].op = op
      })
    }

    Object.keys(filterMapping).forEach(function (key) {
      var values = filterMapping[key].value

      chain = chain.filter(function (element) {
        return values
            .map(utils.toNative)
            .map(function (value) {
              var op = filterMapping[key].op
              var isDifferent = key.indexOf('!=') !== -1 // op === '!='
              var isRange = key.indexOf('<') !== -1 || key.indexOf('>') !== -1 || key.indexOf('<=') !== -1 || key.indexOf('>=') !== -1 //     op === '<' || op === '>' || op === '<=' || op === '>='
              var isLike = key.indexOf('~') !== -1 || key.indexOf('~=') !== -1 || key.indexOf('=~') !== -1  // op === '~' || op === "~=" || op === '=~'
              var isIn = key.indexOf('|=') !== -1
              var path = key.replace(operatorsRegex, '')
              var elementValue = _.get(element, path)

              if (isRange) {
                switch (op) {
                  case '<':
                    return elementValue < value
                  case '>':
                    return elementValue > value
                  case '<=':
                    return elementValue <= value
                  case '>=':
                    return elementValue >= value
                  default:
                    return false
                }
              } else if (isDifferent) {
                return value !== elementValue
              } else if (isLike) {
                return new RegExp(value, 'i').test(elementValue)
              } else if (isIn) {
                var inValues = value.toString().split('|')
                inValues = _.map(inValues, function (val) {
                  return utils.toNative(val)
                })
                if (Array.isArray(elementValue)) {
                  return _.intersection(elementValue, inValues).length > 0
                } else {
                  return _.includes(inValues, elementValue)
                }
              } else {
                return _.matchesProperty(path, value)(element)
              }
            }).reduce(function (a, b) {
              return a || b
            })
      })
    })

    // Sort
    if (_sort) {
      var sortsParams = _sort.split(',')

      var sortMapping = {}
      sortsParams.forEach(function (sortParam) {
        var order = sortParam[0] === '-' ? 'desc' : 'asc'
        var sortField = sortParam.substring(1)
        sortMapping[sortField] = order
      })

      chain = chain.orderBy(_.keys(sortMapping), _.values(sortMapping)) // TODO iteration order is not guaranteed
    }

    // Slice result
    if (_end || _limit || _page) {
      res.setHeader('X-Total-Count', chain.size())
      res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count')
    }

    if (_page) {
      _page = parseInt(_page, 10)
      _page = _page >= 1 ? _page : 1
      _limit = parseInt(_limit, 10) || 10
      var page = utils.getPage(chain.value(), _page, _limit)
      var links = {}
      var fullURL = getFullURL(req)

      if (page.first) {
        links.first = fullURL.replace('page=' + page.current, 'page=' + page.first)
      }

      if (page.prev) {
        links.prev = fullURL.replace('page=' + page.current, 'page=' + page.prev)
      }

      if (page.next) {
        links.next = fullURL.replace('page=' + page.current, 'page=' + page.next)
      }

      if (page.last) {
        links.last = fullURL.replace('page=' + page.current, 'page=' + page.last)
      }

      res.links(links)
      chain = _.chain(page.items)
    } else if (_end) {
      _offset = parseInt(_offset, 10) || 0
      _end = parseInt(_end, 10)
      chain = chain.slice(_offset, _end)
    } else if (_limit) {
      _offset = parseInt(_offset, 10) || 0
      _limit = parseInt(_limit, 10)
      chain = chain.slice(_offset, _offset + _limit)
    }

    if (_fields) {
      chain = chain.map(function (element) {
        return _.pick(element, _fields.split(','))
      })
    }
    // embed and expand
    chain = chain
      .cloneDeep()
      .forEach(function (element) {
        embed(element, _embed)
        expand(element, _expand)
      })

    res.locals.data = chain.value()
    next()
  }

  // GET /name/:id
  // GET /name/:id?_embed=&_expand
  function show (req, res, next) {
    var _embed = req.query._embed
    var _expand = req.query._expand
    var id = utils.toNative(req.params.id)
    var resource = db.get(name).getById(id).value()

    if (resource) {
      // Clone resource to avoid making changes to the underlying object
      resource = _.cloneDeep(resource)

      // Embed other resources based on resource id
      // /posts/1?_embed=comments
      embed(resource, _embed)

      // Expand inner resources based on id
      // /posts/1?_expand=user
      expand(resource, _expand)

      res.locals.data = resource
    }

    next()
  }

  // POST /name
  function create (req, res, next) {
    for (var key in req.body) {
      req.body[key] = utils.toNative(req.body[key])
    }

    var resource = db.get(name)
      .insert(req.body)
      .value()

    res.status(201)
    res.locals.data = resource
    next()
  }

  // PUT /name/:id
  // PATCH /name/:id
  function update (req, res, next) {
    for (var key in req.body) {
      req.body[key] = utils.toNative(req.body[key])
    }

    var id = utils.toNative(req.params.id)
    var chain = db.get(name)

    chain = req.method === 'PATCH'
      ? chain.updateById(id, req.body)
      : chain.replaceById(id, req.body)

    var resource = chain.value()

    if (resource) {
      res.locals.data = resource
    }

    next()
  }

  // DELETE /name/:id
  function destroy (req, res, next) {
    var resource = db.get(name).removeById(utils.toNative(req.params.id)).value()

    // Remove dependents documents
    var removable = db._.getRemovable(db.getState())

    _.each(removable, function (item) {
      db.get(item.name).removeById(item.id).value()
    })

    if (resource) {
      res.locals.data = {}
    }

    next()
  }

  router.route('/')
    .get(list)
    .post(create)

  router.route('/:id')
    .get(show)
    .put(update)
    .patch(update)
    .delete(destroy)

  return router
}
